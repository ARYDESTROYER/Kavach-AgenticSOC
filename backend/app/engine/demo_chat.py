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

import calendar
import functools
import json
import math
import re
from dataclasses import dataclass, field, replace
from datetime import date, datetime, timedelta, timezone
from decimal import ROUND_HALF_UP, Decimal
from typing import Any, Callable, Iterable, Mapping, Sequence

from ..agents.blocks import display_text
from ..agents.chat_entity import entity_turn_question, entity_value, parse_entity_question
from ..agents.chat_followups import suggestion_question
from ..agents.chat_protocol import parse_title
from ..agents.chat_starter_text import (
    LEGACY_TEMPLATES as LEGACY_STARTER_TEMPLATES,
    TEMPLATES as STARTER_TEMPLATES,
    format_age,
    parse_starter_question,
    parse_starter_turn,
    ref_value,
)
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
from ..agents.chat_tools.cases import ASSIGNEE_ME_NOBODY, ASSIGNEE_ME_OWN
from ..agents.chat_tools.common import console_num, fmt_pct, round_half_up, visible_text
from ..agents.chat_tools.taint import REFUSED_TAINT
from ..constants import OPEN_CASE_STATUSES, TERMINAL_CASE_STATUSES, UNTRUSTED_CLOSE, UNTRUSTED_OPEN
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
# ``step N`` (when stored) is the run-log number the console shows for that lookup.
_DIGEST_CALL_RE = re.compile(r"(?:step ([1-9][0-9]{0,3}) )?([a-z][a-z0-9_]{0,63})\(([^()]*)\) → ")
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
    #: The console map's own words for the page ("theme", "dark mode" for Appearance &
    #: customization; "case id", "nomenclature" for Cases), from the Help Center corpus
    #: (``_target_keywords``): a change answer keeps a page they name.
    keywords: tuple[str, ...] = ()


@functools.lru_cache(maxsize=1)
def _console_keywords() -> dict[str, tuple[str, ...]]:
    """Every console target's keywords and blurb words from the bundled console map (the
    same corpus ``app_help`` reads). Fail-soft: an unreadable corpus gives none."""
    try:
        from ..knowledge import get_app_knowledge

        knowledge = get_app_knowledge()
        return {tid: tuple(t.keywords) for tid, t in knowledge.targets.items()}
    except Exception:  # noqa: BLE001 -- a missing corpus only loses the keyword match
        return {}


def _target_keywords(target_id: str) -> tuple[str, ...]:
    return _console_keywords().get(target_id, ())


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
    #: What the digest says the lookup returned ("12 cases …", "error: Not found");
    #: untrusted display text, written into an answer only as plain text.
    outcome: str = ""
    #: The run-log step number the console shows for this lookup (``step N`` in the
    #: digest), or None for a digest written without it.
    step: int | None = None

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
    #: Round 13 (#9): each earlier question's console starter as ``(template id,
    #: slots)``, aligned with ``prior_questions`` (None for any other question). An
    #: earlier starter's referenced value lives only here; its ``prior_questions`` entry
    #: is the fenced form's question line ("… the case in the reference below …").
    prior_starters: list[tuple[str, dict[str, Any]] | None] = field(default_factory=list)
    #: Each retained earlier answer as ``(key, question)``: its ``mK`` replay key and
    #: the analyst's question it replied to ("" when none). The step inspector's
    #: follow-ups ("Explain step 2 … of your answer to “…”") name an answer this way.
    prior_answers: list[tuple[str, str]] = field(default_factory=list)
    rounds: list[list[Result]] = field(default_factory=list)
    reference: Reference = field(default_factory=Reference)
    final_only: bool = False
    unrun: bool = False
    legacy: dict[str, Any] | None = None
    legacy_note: str | None = None
    #: Round 13 (SPEC-chat §3.8, §7.3): the console starter this turn asks, as
    #: ``(template id, slots)`` (``agents.chat_starter_text``). A referenced value
    #: (case, rule, source, campaign, technique) lives ONLY here, read from its fence;
    #: ``question`` then holds the question about "the <noun> in the reference below",
    #: so the value is never part of what the planner reads as the question.
    starter: tuple[str, dict[str, Any]] | None = None

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
                allowed=match.group(3) == "the user can open it", requires=match.group(4),
                keywords=_target_keywords(match.group(1))))
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
                text = digest.group(2)
                found = list(_DIGEST_CALL_RE.finditer(text))
                for position, call in enumerate(found):
                    args: list[tuple[str, str]] = []
                    for part in call.group(3).split(", "):
                        arg = _DIGEST_ARG_RE.match(part.strip())
                        if arg:
                            args.append((arg.group(1), arg.group(2)))
                    # The outcome runs to the next call (the digest joins calls with "; ").
                    end = found[position + 1].start() if position + 1 < len(found) else len(text)
                    outcome = text[call.end():end].strip().removesuffix(";").strip()
                    view.prior_calls.append(PriorCall(
                        key=digest.group(1), tool=call.group(2), args=tuple(args), outcome=outcome,
                        step=int(call.group(1)) if call.group(1) else None))


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
    # Round 13: a console starter with a reference or counts reaches the prompt in its
    # fenced form (#9). Like a model that honours the fence, the planner keeps the
    # value as data (``view.starter``) and reads only the question line, which names
    # "the <noun> in the reference below" (or carries server-computed counts).
    rendered = parse_starter_turn(view.question)
    if rendered is not None:
        view.starter = rendered
        view.question = view.question.split("\n", 1)[0].strip()
    else:
        # An Ask AI chip's question reaches the prompt in its fenced form (#9): the
        # planner reads the question it stands for, as a model reads the fenced reference.
        view.question = entity_turn_question(view.question) or view.question
        # A starter sent as written (no slot, so nothing to fence) or typed by the
        # analyst word for word: the same plan (a typed value is the analyst's own).
        view.starter = parse_starter_question(view.question)
    _parse_history(view, msgs[:live])
    asked_last: str | None = None
    for message in msgs[:live]:
        # Earlier user turns are replayed as plain user messages (never a tool result,
        # which opens with an engine header, nor the product reference).
        content = _content(message)
        if (_role(message) == "user" and content.strip() and not TOOL_CALL_HEADER_RE.match(content.split("\n", 1)[0])
                and not content.startswith(PRODUCT_REFERENCE_HEADER)):
            asked = (extract_user_turn(content) or content).strip()
            earlier = parse_starter_turn(asked)
            if earlier is not None:
                # Like the live turn: the value stays data (``prior_starters``) and the
                # question line names "the <noun> in the reference below".
                asked_last = asked.split("\n", 1)[0].strip()[:500]
            else:
                asked_last = (entity_turn_question(asked) or asked)[:500]
                earlier = parse_starter_question(asked_last)
            view.prior_questions.append(asked_last)
            view.prior_starters.append(earlier)
        elif _role(message) == "assistant" and _fence_body(content, "prior_answer"):
            # A replayed answer: the engine numbers them m1, m2 … oldest first.
            view.prior_answers.append((f"m{len(view.prior_answers) + 1}", asked_last or ""))
            asked_last = None

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
    """A whole figure with thousands separators, rounded half up like the console's
    gauge and the step summaries (T1): 98.5 -> "99", never Python's half-to-even "98"."""
    number = _num(value)
    return "0" if number is None else f"{round_half_up(number):,}"


def _dec(value: Any, places: int = 1) -> str:
    number = _num(value)
    if number is None:
        return "not measured"
    text = f"{number:,.{places}f}"
    return text[:-2] if places == 1 and text.endswith(".0") else text


#: ``number`` as the console writes it, rounded half up (the one helper the tools' step
#: summaries use too).
_console_num = console_num


def _pct(value: Any, *, ratio: bool = False) -> str:
    """A rate exactly as the console's figures show it (Round 13 close: one figure,
    one form): a whole percent from 10% up, one decimal under 10%, "<1%" for a sliver,
    rounded half up, so the prose beside a key-figure tile never says "77.5%" where the
    tile says "78%". The tools' step summaries share the helper (``fmt_pct``)."""
    return fmt_pct(value, ratio=ratio, missing="not measured")


def _points(value: Any) -> str:
    """A change in percentage points as the console's comparison shows it: one decimal
    under 10 points, whole points from 10 up, rounded half up."""
    number = _num(value)
    if number is None:
        return "not measured"
    return _console_num(number, 1 if abs(number) < 10 else 0)


def _score(value: Any) -> str:
    """A 0 to 100 score (an average risk) as the console's tables and tiles show it:
    "7/100", rounded half up."""
    number = _num(value)
    if number is None:
        return "not measured"
    return f"{_console_num(number, 0)}/100"


def _usd(value: Any) -> str:
    number = _num(value) or 0.0
    if number == 0:
        return "$0.00"
    return f"${number:,.4f}" if abs(number) < 1 else f"${number:,.2f}"


def _minutes(value: Any) -> str:
    number = _num(value)
    if number is None:
        return "not measured"
    if number >= 120:
        return f"{_dec(number / 60)} h"
    return f"{_dec(number)} min"


def _plural_noun(noun: str) -> str:
    """"severity" -> "severities", "source IP" -> "source IPs", "host" -> "hosts"."""
    if re.search(r"[^aeiou]y$", noun):
        return noun[:-1] + "ies"
    if re.search(r"(?:s|x|ch|sh)$", noun):
        return noun + "es"
    return noun + "s"


def _plural(n: Any, one: str, many: str | None = None) -> str:
    number = _num(n)
    word = one if number is not None and round_half_up(number) == 1 else (many or one + "s")
    return f"{_count(n)} {word}"


#: Operator ask 3 (no truncation; final review L4): the narration never clips a value
#: tighter than the lookup that returned it. Every observation string is already
#: bounded where its tool builds it (the shared case projection keeps a case id to 128
#: characters, a title to 160, a rule or a source to 120 and an entity to 300; a top
#: value or a grouped label to 200 or 300; an indicator to 512), so a case title or a
#: rule name reads in full, exactly as the lookup returned it, and the console wraps a
#: long one instead of the prose cutting it mid-word ("account takeov…"). This bound
#: only stops a malformed observation from flooding the prose.
_NARRATED_CHARS = 512


def _code(value: Any, limit: int = _NARRATED_CHARS) -> str:
    """A log- or case-derived value as inline code, no backticks. Invisible characters
    are written as visible ``\\uXXXX`` escapes (``visible_text``, as the chart labels
    show them), never deleted: ``ad``+ZWSP+``min`` must not read as ``admin``. Shown
    whole (:data:`_NARRATED_CHARS`): pass a smaller ``limit`` only for a value the
    narration itself bounds (a digest input), never for a name a lookup returned."""
    text = visible_text(value if isinstance(value, str) else ("" if value is None else str(value)), limit)
    text = text.replace("`", "'").strip()
    return f"`{text}`" if text else "`(blank)`"


_MARKDOWN_SPECIALS_RE = re.compile(r"[`*_\[\]<>#|~]")


def _plain(value: Any, limit: int = 240) -> str:
    """Untrusted prose (an evidence summary) as plain text: no Markdown can survive."""
    text = display_text(value if isinstance(value, str) else "", limit)
    return _MARKDOWN_SPECIALS_RE.sub("", text).strip()


_MARKDOWN_ESCAPE_RE = re.compile(r"([\\`*_\[\]<>#|~])")


def _escaped(value: Any, limit: int = 240) -> str:
    """Untrusted text shown as written: every Markdown special is backslash-escaped
    rather than deleted, so ``NEEDS_HUMAN``, ``svc_backup`` and ``161 alerts -> 95
    cases`` keep every character and none of them becomes formatting."""
    text = display_text(value if isinstance(value, str) else "", limit).strip()
    return _MARKDOWN_ESCAPE_RE.sub(r"\\\1", text)


def _join(items: Sequence[str], conj: str = "and") -> str:
    items = [i for i in items if i]
    if not items:
        return ""
    if len(items) == 1:
        return items[0]
    return f"{', '.join(items[:-1])} {conj} {items[-1]}"


#: How much of a compared period's name is narrated: the whole of it ("previous 180
#: days (14 Oct 2025 to 12 Apr 2026)" is 47 characters), as the blocks show it
#: (``blocks.MAX_LABEL``), never cut mid-date.
_PERIOD_CHARS = 60


def _window(obs: Mapping[str, Any], fallback: str = "the selected window") -> str:
    value = obs.get("window")
    return display_text(value, 60) if isinstance(value, str) and value.strip() else fallback


_BARE_PERIODS = frozenset({"today", "yesterday", "this week", "last week", "this month", "last month",
                           "this quarter", "last quarter", "this year", "last year"})


def _in(label: str) -> str:
    """A window label with the words that introduce it: "in the last 24 hours",
    "over all time (since 3 Nov 2025)", "in September 2026", "this week", "since 1
    Mar 2026", "in the same 24 hours a year earlier" (SPEC D7: humanised labels, never
    "in the all time")."""
    text = (label or "").strip()
    low = text.lower()
    if not text:
        return "in the selected window"
    if (low.startswith(("last ", "past ", "previous ", "same ", "selected "))
            and low.split(" (")[0] not in _BARE_PERIODS):
        return f"in the {text}"
    if low.startswith("all time"):
        return f"over {text}"
    if low.split(" (")[0] in _BARE_PERIODS or low.startswith(("since ", "from ", "between ", "until ")):
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
class StepRef:
    """A step inspector follow-up (``StepInspector.tsx``): "Explain step 2 (Counted
    cases) of your answer to “…”: …" or "Run step 2 (…) of your answer to “…” again …".
    ``recency`` names which of several answers to the same question (1 = latest, 0 =
    unique or unnamed); ``quote`` is that question as the console quoted it."""

    verb: str            # "explain" | "rerun"
    index: int
    label: str
    quote: str | None = None
    recency: int = 0


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
    # A time phrase the planner could not read (said in the answer, never dropped); a
    # period named without its year that the anchor could not date ("September"); and
    # whether this ask's window was dated by the anchor lookup (its result is then
    # planner context, never the answer's data).
    unread: str | None = None
    undated: str | None = None
    anchored: bool = False
    # Round 12 WP-ASK: the question is an "Ask AI" chip's server-worded question, so its
    # value came from the console, not the analyst's keyboard. Like a model that honours
    # the indicator taint rule (§4.8), the plan never sends that value to a third-party
    # lookup (the engine would refuse it anyway).
    no_lookup: bool = False
    # Round 12 WP-GEN-A: a step inspector follow-up about one step of an earlier answer.
    step: StepRef | None = None
    # Round 13 (SPEC-chat §3.4, §3.14, §7.3): the console starter template this ask
    # plans, and its slots (counts, time labels and the fenced reference value), so a
    # plan and its final read the value as data, never from the question text.
    starter: str | None = None
    starter_slots: tuple[tuple[str, Any], ...] = ()
    # Round 13 polish: the question is about the signed-in analyst's own cases ("my
    # cases", "assigned to me"): every case lookup the plan sends carries assignee
    # "me", and an answer whose lookups cannot filter by assignee says so.
    mine: bool = False
    # Polish round PB6: a detection rule an "Investigate rule …" question names; its
    # case lookups filter on it (as "detection rule X" does, :func:`_case_rule`).
    rule: str | None = None

    def slot(self, name: str) -> Any:
        return next((value for key, value in self.starter_slots if key == name), None)


_IPV4_RE =re.compile(r"(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?!\d)(?!\.\d)")
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
# Records a question can ask to see: cases and their kinds (the verdict nouns),
# incidents, alerts. A console noun after one makes it a qualifier ("the cases page",
# "the open cases KPI", "the false positives rate"): that question is about the console
# or a measure, not about the records themselves.
_RECORD_NOUN = (r"(?:cases|incidents|tickets|investigations|escalations|alerts|detections|"
                r"(?:true|false)[- ]positives)\b")
_RECORD_ONE = r"(?:case|incident|ticket|alert|detection)\b"
#: Parts of the console a record noun can qualify ("each case action", "every incident
#: badge", "each alert icon"): the question is about the console, not about records.
#: Shared with ``knowledge/answer.py`` (the AI-unavailable Help Center route).
_CONSOLE_PARTS = (r"actions?|chips?|badges?|permissions?|roles?|shortcuts?|icons?|colou?rs?|options?|sections?|"
                  r"screens?|dialogs?|modals?|toolbars?|tooltips?|glyphs?|toggles?|switches|controls?|headers?|"
                  r"layouts?|themes?|links?")
_NOT_CONSOLE = (r"(?!\s+(?:kpis?|tiles?|cards?|metrics?|charts?|columns?|pages?|tabs?|views?|filters?|settings?|"
                r"widgets?|panels?|rates?|counts?|polic(?:y|ies)|lifecycles?|workflows?|menus?|buttons?|"
                r"status(?:es)?|severit(?:y|ies)|priorit(?:y|ies)|fields?|types?|states?|ids?|numbers?|"
                r"titles?|formats?|templates?|decisions?|model|verdicts?|outcomes?|dispositions?|levels?|labels?|"
                r"categor(?:y|ies)|kinds?|class(?:es)?|stages?|steps?|phases?|rules?|queues?|attributes?|"
                + _CONSOLE_PARTS + r")\b)")
# The records an "explain" can name: the record nouns and the rows of a list ("the
# results", "the ones"), never followed by a console noun ("the cases view").
_RECORD_ITEMS = r"(?:" + _RECORD_NOUN + r"|(?:ones|results|findings|rows|matches)\b)" + _NOT_CONSOLE
_RECORD_ITEM_ONE = r"(?:case|incident|ticket|alert|detection|finding|result|row|match)\b" + _NOT_CONSOLE
# A few qualifiers before a record noun ("the open critical cases"); never a
# preposition, so "the top 3 tabs in case detail" names tabs, not cases.
_RECORD_QUALIFIERS = r"(?:(?!(?:in|on|of|for|from|to|at|about|with|into|across)\b)[a-z0-9'-]+\s+){0,3}?"
# Where a bare "each", "these" or "the top 3" ends: the clause stops there ("… and
# explain each.", "explain the top 3 by risk"), so it points back at listed records.
_CLAUSE_END = (r"(?=\s*(?:[,.?!;:]|$)|\s+(?:and\b(?!\s+every\b)|then\b|with\b|by\b|briefly\b|please\b|"
               r"for me\b|in turn\b|in detail\b))")
_THESE_RECORDS = (r"(?:these|those)(?:" + _CLAUSE_END + r"|\s+(?:are|were|have|had)\b|\s+" + _RECORD_QUALIFIERS
                  + _RECORD_ITEMS + r")")
# "Explain" whose object is the records the answer lists, never a term: "… and explain
# each", "explain why each one is critical", "explain each of the open critical cases",
# "explain them", "explain the top 3 (cases)", "with an explanation for each". A term
# after it keeps the question a definition: "explain what each severity level means",
# "explain each case status", "explain each of the verdicts", "explain the first 3
# steps of onboarding" name no records.
_EXPLAIN_RECORDS_RE = re.compile(
    r"\bexplain\w*(?:\s+(?:why|how|what))?(?:\s+[a-z']+){0,3}?\s+(?:"
    r"(?:each|every)(?:\s+one)?(?:" + _CLAUSE_END + r"|\s+(?:is|was|has|had|got|were)\b"
    r"|\s+of\s+(?:them\b|" + _THESE_RECORDS + r"|(?:the|our|my|all|today's)\s+" + _RECORD_QUALIFIERS
    + _RECORD_ITEMS + r"))"
    r"|(?:each|every)\s+(?:[a-z-]+\s+){0,2}?" + _RECORD_ITEM_ONE
    + r"|them\b|they\b(?!\s+(?:mean|means|meant|stand|stands)\b)"
    r"|" + _THESE_RECORDS
    + r"|(?:the\s+)?(?:top|first|bottom|last)\s+\d{1,3}(?:" + _CLAUSE_END + r"|\s+" + _RECORD_QUALIFIERS
    + _RECORD_ITEMS + r")"
    r"|the\s+(?:results|list|ones|rows|matches|findings)\b" + _NOT_CONSOLE + r")")
# A request for records rather than for what a word means: a list verb first ("show
# the open cases", "list false positives this week"; never a how-to such as "show me
# how to close cases"), "which <records>", "what are the <records>", "the top 10
# <records>", "explain the <records>", or each one of them ("what does each open
# critical case involve").
_RECORDS_ASK_RE = re.compile(
    r"^\s*(?:please\s+)?(?:(?:can|could|would|will)\s+(?:you|i|we)\s+(?:please\s+)?)?"
    r"(?:see|show|list|give|get|pull|display|find|fetch|rank|enumerate|look at)\b"
    r"(?!.{0,40}\b(?:how (?:to|do|can|should)|where (?:to|do|can|is|are))\b)"
    r".{0,80}?\b" + _RECORD_NOUN + _NOT_CONSOLE
    + r"|\bwhich\s+(?:[a-z0-9-]+\s+){0,3}?" + _RECORD_NOUN + _NOT_CONSOLE
    + r"|\bwhat(?:'s|\s+is|\s+are|\s+was|\s+were)\s+(?:the|our|my|all|any)\s+(?:[a-z0-9-]+\s+){0,4}?"
    + _RECORD_NOUN + _NOT_CONSOLE
    + r"|\bwhat(?:'s|\s+is|\s+was)\s+the\s+(?:riskiest|highest[- ]risk|most critical|worst|biggest|newest|latest|"
    r"oldest|most recent)\s+(?:[a-z-]+\s+){0,2}?" + _RECORD_ONE + _NOT_CONSOLE
    + r"|\b(?:top|the)\s+\d{1,3}\s+(?:[a-z-]+\s+){0,3}?" + _RECORD_NOUN + _NOT_CONSOLE
    + r"|\bexplain\w*\s+(?:the|our|my|all|today's)\s+(?:[a-z0-9-]+\s+){0,3}?" + _RECORD_NOUN + _NOT_CONSOLE
    + r"|\b(?:each|every)\s+(?:[a-z-]+\s+){0,2}?" + _RECORD_ONE + _NOT_CONSOLE)
# Defining words that hold even beside a request for records ("list the escalated
# cases; what does escalated mean?"): unlike a bare "explain" or "what are", they
# always ask what something means.
_DEFINES_STRONGLY_RE = re.compile(
    r"\b(?:meaning|means?|defin(?:e|es|ed|ition)|stands? for)\b|"
    r"\bhow (?:is|are) .{0,40}(?:calculated|computed|measured|derived|scored)\b|"
    r"\bhow do (?:you|we) (?:calculate|compute|measure)\b")
# The verdict nouns as records ("list false positives this week"), never the rate.
_VERDICT_RECORDS_RE = re.compile(r"\b(?:true|false)[- ]positives\b(?![- ]rates?\b)")


def _asks_for_records(lowered: str) -> bool:
    """Does the question ask to see records (cases, incidents, alerts, true or false
    positives), or to explain the ones it lists? Such a question is a data request even
    when it says "explain" or "what are": the definition branches never take it."""
    return bool(_EXPLAIN_RECORDS_RE.search(lowered) or _RECORDS_ASK_RE.search(lowered))


#: A defining word whose subject points back at the records the question lists ("show
#: the escalated cases and explain what each one MEANS", "… what they mean for us"):
#: it asks what each listed record means for the analyst, not what a term means.
_MEANS_THE_RECORDS_RE = re.compile(
    r"\b(?:each(?:\s+one)?(?:\s+of\s+(?:them|these|those))?|every\s+one|they|them|these|those)\s+"
    r"(?:means?|meant|stands?\s+for)\b")


def _defines(lowered: str, records: bool) -> bool:
    """Does the question ask what a term, measure or setting means? A bare "explain"
    or "what are" is definitional only when the question asks for no records: "Show
    the top 10 open cases by risk and explain each" wants the cases, and "Explain the
    false positive rate" wants the definition (with our figure). Beside a request for
    records, a defining word holds only when its subject is a term ("what does
    escalated mean", "what each case status means"), never when it points back at the
    listed records ("explain what each one means")."""
    if not _DEFINITION_RE.search(lowered):
        return False
    return not records or bool(_DEFINES_STRONGLY_RE.search(_MEANS_THE_RECORDS_RE.sub(" ", lowered)))


_ACCESS_RE = re.compile(r"\b(what can (?:i|you|chat) do|my access|my role|my permissions?|permissions?|"
                        r"allowed to|am i able)\b")
_OVERVIEW_RE = re.compile(r"\b(version|demo mode|what is enabled|which features|deployment|configured)\b")
_CHANGE_RE = re.compile(
    r"^\s*(?:please\s+|can you\s+|could you\s+|would you\s+)?(close|resolve|delete|remove|disable|enable|"
    r"assign|reassign|escalate|approve|reject|create|add|update|change|modify|set|turn (?:on|off)|"
    r"restart|reset|block|isolate|contain|quarantine|suppress|mute|acknowledge|ack|edit|rename|"
    r"tune|purge|wipe)\b")
#: A polite opening before a request's verb ("please", "can you", "help me").
_POLITE_RE = (r"^\s*(?:(?:please|pls|hey|hi|ok|okay)[,\s]+)?"
              r"(?:(?:can|could|would|will) you\s+(?:please\s+)?|help me\s+|i (?:want|need) you to\s+)?")
#: Response actions (final review L4): isolating or containing a host, blocking an
#: address, quarantining a file, stopping a process. This console has none, from chat
#: or anywhere else (no write-side response actions), so the answer says where they
#: run instead of pointing at a console page that cannot do them.
_RESPONSE_VERB_RE = re.compile(
    _POLITE_RE + r"(?:go ahead and\s+)?(?P<verb>isolate|contain|quarantine|sinkhole|blackhole|kill(?![- ]chain)|"
    r"terminate|block|unblock|ban|lock out|lock)\b(?P<rest>.*)$")
#: Verbs that are a response action whatever they act on ("contain the outbreak").
_RESPONSE_STRONG = frozenset({"isolate", "contain", "quarantine", "sinkhole", "blackhole", "kill"})
#: What the other verbs must act on to be a response action ("block this IP").
_RESPONSE_OBJECT_RE = re.compile(
    r"\b(?:hosts?|machines?|servers?|endpoints?|workstations?|laptops?|devices?|ips?|ip address(?:es)?|"
    r"address(?:es)?|domains?|urls?|hash(?:es)?|files?|process(?:es)?|pids?|users?|accounts?|senders?|"
    r"emails?|attackers?|traffic|connections?|it|this|that|them|these|those)\b")
#: Console objects a verb such as "kill" or "lock" can also act on ("kill the export
#: job"): a change chat cannot make, answered as one, never as a response action.
_CONSOLE_OBJECT_RE = re.compile(
    r"\b(?:jobs?|rules?|sources?|feeds?|connectors?|cases?|incidents?|reports?|dashboards?|notifications?|"
    r"channels?|webhooks?|proposals?|runbooks?|playbooks?|settings?|roles?|sessions?|tasks?|chats?|"
    r"conversations?|answers?|questions?|lookups?)\b")
#: Block and deny lists live in a firewall or a proxy, not in this console.
_RESPONSE_LIST_RE = re.compile(r"\b(?:block|deny|ban)[- ]?lists?\b")
#: The verbs that can also act on a console object ("kill the export job", "lock the
#: case"): a change chat cannot make. Isolating or containing never acts on one.
_CONSOLE_VERBS = frozenset({"kill", "lock", "lock out", "terminate", "block", "unblock", "ban"})
#: The verb used as a noun or a modifier: "lock-out events for user dsingh", "kill
#: switch status", "block events from 203.0.113.7". A read, never a request to act.
_RESPONSE_NOUN_USE_RE = re.compile(
    r"^[\s-]*(?:outs?[\s-]+)?(?:events?|attempts?|logs?|alerts?|activity|history|status|counts?|rates?|"
    r"polic(?:y|ies)|thresholds?|records?|reports?|trends?|switch(?:es)?)\b")
_RESPONSE_DET = r"^\s*(?:(?:the|this|that|these|those|our|any|all|its|their)\s+)?"
#: Isolating a cause, or the records ("help me isolate the root cause of the newest
#: case", "isolate the cases for host dc01"): always a read.
_RESPONSE_READ_OBJECT_RE = re.compile(_RESPONSE_DET + r"(?:root[- ]causes?|causes?|events?|cases?)\b")
#: Containing the issue, the damage or the impact is a real request to act ("contain
#: the issue on host srv-db-01", "contain the damage now"), unless the clause is about
#: a case record ("contain the issue with case-abc123") or a question follows it
#: (``_LATER_QUESTION_RE``: "contain the damage: which hosts are affected?").
_RESPONSE_FIGURATIVE_RE = re.compile(_RESPONSE_DET + r"(?:issues?|problems?|damage|impact|scope|blast radius)\b")
_RECORD_REF_RE = re.compile(r"\b(?:cases?|incidents?|tickets?)\b")
#: A question after the verb's clause ("help me contain the damage: which hosts are
#: affected?"): the analyst asks to read something, not to act.
_LATER_QUESTION_RE = re.compile(
    r"(?:[:;]|\s[-\u2013\u2014]\s)\s*(?:which|what|who|whose|where|when|why|how)\b"
    r"|(?:[:;,]|\s[-\u2013\u2014]\s)\s*(?:which|what|who|whose|where|when|why|how|is|are|was|were|did|does|do|"
    r"has|have|had|should|can|could)\b[^:;,]*\?\s*$")
#: Requests that are not about this deployment at all (final review L4): writing code
#: or scripts, and jokes, poems or stories. One honest sentence says what chat
#: answers instead, never a case list or an unrelated Help Center passage.
_CODE_ASK_RE = re.compile(
    _POLITE_RE + r"(?:write|generate|create|code|build|make|draft|develop|program)\b(?P<rest>.*)$")
_CODE_NOUN_RE = re.compile(
    r"\b(?:scripts?|programs?|code|functions?|snippets?|one-liners?|apps?|applications?|web ?sites?|"
    r"web ?pages?|games?|exploits?|payloads?|malware|keyloggers?|bots?|macros?|regex(?:es)?)\s*$")
#: A story is creative only as "a story", "another story", "some stories" or bare
#: "stories" ("a funny story"): "the story of this case" is the case's own story, a
#: question about it.
_CREATIVE_RE = re.compile(
    _POLITE_RE + r"(?:tell|write|give|make up|compose)\s+(?:me\s+|us\s+)?(?:"
    r"(?:(?:a|an|another|some)\s+)?(?:\w+\s+)?(?:jokes?|poems?|songs?|haikus?|limericks?|riddles?)"
    r"|(?P<story>(?:a|an|another|some)\s+(?:\w+\s+)?stor(?:y|ies)|stories))\b(?P<rest>.*)$")
#: What a story about the analyst's OWN security data names (a case id, an entity or
#: indicator value, checked beside this): one of their records with a definite
#: determiner ("this case", "the breach", "our incidents", "today's alerts"), a
#: back-reference ("a story about it"), or a period ("what happened overnight", "so
#: far", "this week"). A generic noun after an indefinite article or as a bare plural
#: ("a phishing attack", "an intrusion", "cyber attacks", "famous breaches") is fiction.
_SOC_SUBJECT_RE = re.compile(
    r"\b(?:this|that|these|those|the|our|my|today's|yesterday's|tonight's|last night's)\s+(?:[\w-]+\s+){0,2}?"
    r"(?:cases?|incidents?|alerts?|attacks?|breach(?:es)?|intrusions?|compromises?|campaigns?|hosts?|machines?|"
    r"servers?|endpoints?|users?|accounts?|ips?|domains?|hash(?:es)?|indicators?|iocs?|sign[- ]?ins?|logins?|"
    r"events?|logs?|shifts?|activity|detections?)\b"
    r"|\b(?:it|them)\b"
    r"|\b(?:today|yesterday|tonight|overnight|so far|happened|going on)\b"
    r"|\b(?:this|last|past) (?:hour|day|night|week|month|quarter|year)\b")
#: What chat answers: the agent prompt's own scope (``prompts._CHAT_AGENT_BODY``).
_CHAT_SCOPE = ("Chat answers questions about your security data (cases, logs, metrics, threat intelligence and "
               "platform health) and about this console, using read-only lookups.")
#: The step inspector's follow-ups (``StepInspector.tsx`` ``explainStepQuestion`` and
#: ``retryStepQuestion``): engine words around the step's template label and, when
#: known, a quote of the question its answer replied to.
_STEP_ASK_RE = re.compile(
    r"^(?P<verb>explain|run) step (?P<index>\d{1,4}) \((?P<label>[^\n]{1,120}?)\)"
    r"(?: of your (?:(?P<which>latest|second|third|fourth|fifth|\d{1,4}(?:st|nd|rd|th))(?: most recent)? )?"
    r"answer to [\u201c\"](?P<quote>[^\n]{1,200})[\u201d\"])?"
    r"(?P<rest>(?::|\s+again\b)[^\n]*)$",
    re.IGNORECASE)
_RECENCY_WORDS = {"latest": 1, "second": 2, "third": 3, "fourth": 4, "fifth": 5}


def _step_ask(question: str) -> StepRef | None:
    """The step a step inspector follow-up names, or None for any other question.
    The parenthesised label must be one the run log writes (a lookup's template
    label or a model step's): "Run step 3 (block the IP) again on the firewall" is
    the analyst's own request, never a rerun of an unrelated lookup."""
    match = _STEP_ASK_RE.match(question.strip())
    if not match:
        return None
    verb = match.group("verb").lower()
    rest = match.group("rest").lower()
    if verb == "explain" and not rest.startswith(":"):
        return None
    if verb == "run" and not rest.lstrip().startswith("again"):
        return None
    if not _is_step_label(match.group("label")):
        return None
    which = (match.group("which") or "").lower()
    recency = _RECENCY_WORDS.get(which) or (int(re.sub(r"\D", "", which)) if which else 0)
    return StepRef(verb="explain" if verb == "explain" else "rerun", index=int(match.group("index")),
                   label=match.group("label").strip(), quote=(match.group("quote") or "").strip() or None,
                   recency=recency)


def _step_shaped_label(question: str) -> str | None:
    """The analyst's own words in the rerun shape ("Run step 3 (block the IP) again"
    gives "block the IP"), or ``None``. "Explain step 2 (isolate the host): why …?"
    asks a question, not for the change, so only "Run step" counts."""
    match = _STEP_ASK_RE.match(question.strip())
    return match.group("label").strip() if match is not None and match.group("verb").lower() == "run" else None


def _step_shaped_change(question: str) -> bool:
    """"Run step 3 (rename the case) again": the rerun shape around the analyst's own
    write request (not a run-log label) asks for that change, which chat cannot make."""
    label = _step_shaped_label(question)
    return label is not None and _is_change(label.lower())


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
    rf"{_LOG_NOUN}(?P<rest>(?:\s+(?:in|over|for|during|from|within|since|after|before|until|between|on|this|"
    r"last|today|yesterday|all)\b[^,;?.!]*)?)\s*[?.!]*\s*$",
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
_UNIT_LETTER = {"m": "m", "h": "h", "d": "d", "w": "w", "M": "M", "y": "y"}
_UNIT_WORDS = {"m": ("minute", "minutes"), "h": ("hour", "hours"), "d": ("day", "days"), "w": ("week", "weeks"),
               "M": ("month", "months"), "y": ("year", "years")}
_UNIT_HOURS = {"h": 1, "d": 24, "w": 168, "M": 720, "y": 8760}
# A month or quarter word counts only standing alone: "jan-laptop", "dec-web01" and
# "q3-db01" are names (a host, a user), never periods. A full stop ends a sentence
# ("in September.") but not a name ("sep.example").
_ATOM_START = r"(?<![\w.-])"
_ATOM_END = r"(?![\w-]|\.\w)"
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
# "The whole year", "this entire month", "the last full quarter", "a full-year report",
# "a whole month summary", "the whole day": the calendar period itself. Never "a whole
# week" on its own (a duration: "open for a whole week", "an entire year of logs"),
# never a period that names its own month, quarter, year or day ("the whole month of
# May", "the full year 2025", "the whole day yesterday" are read by those rules), never
# "full year-over-year".
_WHOLE_WORD = r"(?:whole|full|entire|complete)"
_WHOLE = rf"(?<!\ba )(?<!\ban ){_WHOLE_WORD}[- ]"
_WHOLE_END = (rf"(?![\w-]|\s+(?:of\s+)?(?:20\d\d|{_MONTH_WORD}|q[1-4]|today|yesterday|"
              r"(?:this|last|previous|prior)\s+(?:week|month|quarter|year))\b)")
#: After "a"/"an" the period still counts when it is hyphenated ("a full-year report")
#: or qualifies a report ("a whole month summary").
_WHOLE_REPORT = (r"(?=\s+(?:\w+\s+){0,2}?(?:reports?|summar(?:y|ies)|reviews?|briefs?|briefings?|overviews?|"
                 r"recaps?|roundups?|round-ups?|digests?)\b)")
_WHOLE_UNITS = (("day", "today", "yesterday"), ("week", "this_week", "last_week"),
                ("month", "this_month", "last_month"), ("quarter", "this_quarter", "last_quarter"),
                ("year", "this_year", "last_year"))
# "For the year", "a report on the quarter", "over the month", "the calendar year": the
# current calendar period. Never "a day in the week" or "day of the week" (a bucket),
# never "for the year before" or "for the month of May" (the period is named next).
_THE_UNIT_GUARD = r"(?<!\bday )(?<!\bdays )(?<!\btime )(?<!\bhour )(?<!\bhours )(?<!\bweek )(?<!\bmonth )"
_THE_UNIT_END = (r"(?![\w-]|\s+(?:of|before|after|since|ago|prior|earlier|later|ending|ended|starting|started|"
                 r"beginning|following|when|where|that|which|we|i|you|they|until|till|through|to date|so far|"
                 r"20\d\d)\b)")
_REPORT_NOUN = r"(?:reports?|summar(?:y|ies)|reviews?|recaps?|overviews?|briefs?|digests?|numbers|stats|figures)"
#: Calendar periods a question implies without naming one: the whole/full/entire period
#: ("the whole year", "a full-year report", "the last full quarter"), the period after
#: a determiner ("for the year", "a report on the quarter", "the calendar month") and a
#: period-end or in-review report ("a year-end report", "the year in review"). Used
#: only when nothing else in the question names a period (:func:`_window_from`): "a
#: full-year report for last year" covers last year.
_IMPLIED_PERIODS: tuple[tuple[str, str], ...] = (
    *((rf"\b(?:last|previous|prior) {_WHOLE}{unit}{_WHOLE_END}", last) for unit, _this, last in _WHOLE_UNITS),
    *((rf"\b{_WHOLE}{unit}{_WHOLE_END}|\b{_WHOLE_WORD}(?:-{unit}{_WHOLE_END}|\s{unit}{_WHOLE_END}{_WHOLE_REPORT})",
       this) for unit, this, _last in _WHOLE_UNITS),
    *((rf"\b(?:the\s+)?calendar[- ]{unit}{_THE_UNIT_END}", this) for unit, this, _last in _WHOLE_UNITS[1:]),
    *(((rf"{_THE_UNIT_GUARD}\b(?:for|in|during|over|across|throughout|on|about|covering|regarding)\s+the\s+"
         rf"{unit}{_THE_UNIT_END}|\b{_REPORT_NOUN}\s+of\s+the\s+{unit}{_THE_UNIT_END}"), this)
      for unit, this, _last in _WHOLE_UNITS[1:]),
    *((rf"\b{unit}[- ]end\b{_WHOLE_REPORT}|\bend[- ]of[- ](?:the[- ])?{unit}{_WHOLE_REPORT}", this)
      for unit, this, _last in _WHOLE_UNITS[2:]),
    *((rf"\b{unit} in review\b", this) for unit, this, _last in _WHOLE_UNITS[1:]),
)
_CALENDAR_PHRASES: tuple[tuple[str, str], ...] = (
    # "The year so far" is this year to date, never all time ("so far" alone is).
    (r"\b(?:ytd|year[- ]to[- ]date|so far this year|(?:the|this) year so far)\b", "ytd"),
    (r"\b(?:mtd|month[- ]to[- ]date|so far this month|(?:the|this) month so far)\b", "this_month"),
    (r"\b(?:qtd|quarter[- ]to[- ]date|so far this quarter|(?:the|this) quarter so far)\b", "this_quarter"),
    (r"\b(?:the|this) week so far\b", "this_week"),
    (r"\btoday(?:'s)?\b|\bthis morning\b|\bso far today\b", "today"),
    (r"\byesterday(?:'s)?\b", "yesterday"),
    (r"\b(?:this|current) (?:calendar )?week(?:'s)?\b|\bweek to date\b", "this_week"),
    (r"\b(?:last|previous|prior) (?:calendar )?week(?:'s)?\b", "last_week"),
    (r"\b(?:this|current) (?:calendar )?month(?:'s)?\b", "this_month"),
    (r"\b(?:last|previous|prior) (?:calendar )?month(?:'s)?\b", "last_month"),
    (r"\b(?:this|current) (?:calendar )?quarter(?:'s)?\b", "this_quarter"),
    (r"\b(?:last|previous|prior) (?:calendar )?quarter(?:'s)?\b", "last_quarter"),
    (r"\b(?:this|current) (?:calendar )?year(?:'s)?\b", "this_year"),
    (r"\b(?:last|previous|prior) (?:calendar )?year(?:'s)?\b", "last_year"),
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
_ISO_DAY_RE = re.compile(rf"\b(?:on|for)\s+{_ISO_DATE}\b")
_QUARTER_YEAR_RE = re.compile(rf"{_ATOM_START}q([1-4])\s*[- ]?\s*(20\d\d)\b|\b(20\d\d)\s*[- ]?\s*q([1-4]){_ATOM_END}")
_QUARTER_ONLY_RE = re.compile(rf"{_ATOM_START}q([1-4]){_ATOM_END}")
_MONTH_YEAR_RE = re.compile(rf"{_ATOM_START}{_MONTH_WORD}\.?\s+(?:of\s+)?(20\d\d)\b")
_ISO_MONTH_RE = re.compile(r"\b(20\d\d)-(0[1-9]|1[0-2])\b(?!-\d)")
_NAMED_MONTH_RE = re.compile(
    rf"\b(?:in|for|during|of|over|on)\s+({_MONTH_WORD}){_ATOM_END}|{_ATOM_START}({_SAFE_MONTH_WORD}){_ATOM_END}")
_YEAR_RE = re.compile(r"\b(?:in|for|during|of|year)\s+(20\d\d)\b|\b(20\d\d)\s+(?:(?:full|whole|entire|calendar)[- ])?"
                      r"(?:report|review|summary|figures|numbers|stats|metrics|posture|performance|year)\b")
# Case age ("older than 3 days", "open for over 14 days", "opened more than a month
# ago"): an upper bound on when the cases were opened, never "opened in the last N
# days" (the opposite set). Each pattern's groups are (number, unit).
_AGE_UNIT = r"(minutes?|mins?|hours?|hrs?|days?|weeks?|wks?|months?|mos?|years?|yrs?)"
_AGE_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(rf"\bolder than\s+(\d{{1,4}})\s*[- ]?{_AGE_UNIT}\b"),
    re.compile(rf"\b(?:more|longer|greater) than\s+(\d{{1,4}})\s*[- ]?{_AGE_UNIT}\s+(?:old|ago)\b"),
    re.compile(rf"\b(?:over|at least|beyond)\s+(\d{{1,4}})\s*[- ]?{_AGE_UNIT}\s+(?:old|ago)\b"),
    re.compile(rf"\b(\d{{1,4}})\s*[- ]?{_AGE_UNIT}\s+(?:old|or (?:more|older|longer))\b"),
    re.compile(rf"\b(?:open|opened|waiting|pending|outstanding|unresolved|unacknowledged|aging|aged|stuck|sitting|"
               rf"untouched|idle)\b(?:\s+[a-z]+){{0,2}}?\s+(?:for\s+)?(?:over|more than|longer than|at least|"
               rf"beyond|in excess of|greater than)\s+(\d{{1,4}})\s*[- ]?{_AGE_UNIT}\b"),
)
# A bound or a range around named periods: "since March", "before September", "from
# 1 Sep to 15 Sep", "between August and September", "after 2024".
_BOUND_WORD_RE = re.compile(r"\b(since|from|after|before|until|till|up to|prior to|earlier than)\s+"
                            r"(?:the\s+(?:start|beginning|end)\s+of\s+)?")
_RANGE_LEAD_RE = re.compile(r"\b(between|from)\s+")
_RANGE_JOIN_RE = re.compile(r"\s+(?:and|to|until|till|through|thru)\s+|\s*(?:–|—)\s*|\s+-\s+")
_BARE_RANGE_JOIN_RE = re.compile(r"\s+(?:to|until|till|through|thru)\s+|\s*(?:–|—)\s*")
_ONWARDS_RE = re.compile(r"^\s*(?:on|onwards?|onward|forward|to (?:now|date|today)|until (?:now|today)|"
                         r"till (?:now|today))\b")
# A time phrase the planner could not turn into a window ("before the incident week",
# "since Tuesday"): named in the answer instead of silently dropped (routing.md §5.16).
_DATE_CUE_RE = re.compile(
    r"\b(?:before|after|until|till|between|since|prior to|earlier than|later than|older than|newer than|as of)"
    r"\s+((?:the\s+)?[a-z0-9][a-z0-9 ,/.'-]{0,40}?)(?=\s*[?.!,;]|\s*$|\s+(?:and|or|by|per|with|that|which|"
    r"please)\b)")
_DATE_WORD_RE = re.compile(
    r"\d|\b(?:minutes?|hours?|days?|weeks?|months?|quarters?|years?|today|yesterday|tonight|morning|"
    r"(?:mon|tues|wednes|thurs|fri|satur|sun)days?|weekend|" + _MONTH_WORD[3:-1] + r")\b")
# A period named with a determiner after "for", "in", "over", "on", "of" ("for the
# fiscal year", "over the weekend", "a report on the fiscal quarter"): a period was
# named even when no rule reads it, so the answer must not say that none was. "For
# each month", "per week", "in a week" and "day of the week" are a breakdown, a
# duration or a bucket, never a period.
_PERIOD_PHRASE_RE = re.compile(
    _THE_UNIT_GUARD + r"\b(?:for|in|during|over|across|throughout|within|on|of|about|covering|regarding)\s+"
    r"(?:the|this|that|our)\s+(?:(?!each\b|every\b|per\b)[a-z0-9'-]+\s+){0,2}"
    r"(?:years?|quarters?|months?|weeks?|days?|fortnight|weekends?|seasons?|holidays?|summer|winter|spring|autumn|"
    r"mornings?|afternoons?|evenings?|nights?)\b")
# Any period word the question uses ("on the year", "the weekend", "last night",
# "Tuesday", "2025"), for the default-window sentence: "No period was named" is said
# only when the question has none. A bucket or a duration ("per week", "each month",
# "a week", "3 days", "how many days", "day of the week") is not a period.
_LOOSE_PERIOD_RE = re.compile(
    r"(?:\b(?:for|in|during|over|across|throughout|within|on|of|about|covering|regarding|since|from|until|till|"
    r"before|after)\s+)?(?:"
    r"\b(?:(?:the|this|that|these|those|our|last|next|past|previous|prior|coming|current|calendar|fiscal|whole|"
    r"full|entire|recent)\s+){1,3}(?:(?:few|several|couple(?:\s+of)?)\s+)?(?:years?|quarters?|months?|weeks?|"
    r"days?|fortnights?|weekends?|mornings?|afternoons?|evenings?|nights?|holidays?|seasons?|summer|winter|"
    r"autumn)\b(?!\s+of\s+the\b)"
    r"|(?<![\w.-])(?:today|tonight|tomorrow|yesterday|weekends?|holidays?|(?:mon|tues|wednes|thurs|fri|satur|sun)days?|"
    + _SAFE_MONTH_WORD + r"|20\d\d|q[1-4]|fy\s?\d{2,4})" + _ATOM_END + r")")
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
    only while a period named without its year waits for the anchor), ``phrase`` the
    planner's own words for it, ``hours`` its span in whole hours when one is
    meaningful (a trailing window; an approximation for calendar periods)."""

    spec: Any
    phrase: str
    hours: int | None = None
    all_time: bool = False
    unit: str | None = None          # the calendar unit of a calendar period
    # A period named without its year, as (kind, payload): ("month", 9), ("since", 3),
    # ("quarter", 3), ("range", (atom, atom)) or ("bound", (word, atom)); the anchor
    # lookup dates it (:func:`_anchored`).
    pending: tuple[str, Any] | None = None
    older: bool = False              # a case-age bound ("older than 3 days"): oldest first

    @property
    def bounded(self) -> bool:
        return not self.all_time and self.spec is not None or self.pending is not None


def _relative(n: int, unit: str) -> Win:
    """``now-<n><unit>`` with its phrase ("the last 90 days", "the last 30 minutes")."""
    n = max(1, n)
    one, many = _UNIT_WORDS[unit]
    phrase = f"the last {one}" if n == 1 else f"the last {n} {many}"
    # Minutes keep their own spec ("now-30m"); a tool that takes whole hours (the shift
    # snapshot) rounds up to the next hour.
    hours = -(-n // 60) if unit == "m" else n * _UNIT_HOURS[unit]
    return Win(spec=f"now-{n}{unit}", phrase=phrase, hours=hours)


def _unit_letter(word: str) -> str:
    """The window letter of a unit word: "mo"/"months" are M, "min"/"minutes" are m."""
    if word.startswith(("mo", "month")):
        return "M"
    if word.startswith("mi"):
        return "m"
    return _UNIT_LETTER.get(word[0], "d")


def _relative_from(number: str, word: str) -> Win:
    return _relative(int(number), _unit_letter(word))


def _month_win(year: int, month: int) -> Win:
    return Win(spec=f"{year:04d}-{month:02d}", phrase=f"{_MONTH_LONG[month - 1]} {year}", hours=720, unit="month")


def _quarter_win(year: int, quarter: int) -> Win:
    return Win(spec=f"{year:04d}-Q{quarter}", phrase=f"Q{quarter} {year}", hours=2160, unit="quarter")


def _since_win(year: int, month: int, anchor: tuple[int, int] | None = None) -> Win:
    hours = None
    if anchor is not None:
        months = (anchor[0] - year) * 12 + anchor[1] - month + 1
        hours = max(1, months) * 720
    return Win(spec={"from": f"{year:04d}-{month:02d}-01"}, phrase=f"since {_MONTH_SHORT[month - 1]} {year}",
               hours=hours)


def _day_phrase(iso: str) -> str:
    try:
        year, month, day = (int(p) for p in iso.split("-"))
        return f"{day} {_MONTH_SHORT[month - 1]} {year}"
    except (ValueError, IndexError):
        return iso


def _age_window(low: str) -> Win | None:
    """A case-age bound ("older than 3 days", "open for over 14 days"): the cases
    opened before ``now-N``, as ``{"to": "now-N<unit>"}`` (an open start)."""
    for pattern in _AGE_PATTERNS:
        match = pattern.search(low)
        if match:
            n, word = max(1, int(match.group(1))), match.group(2)
            letter = _unit_letter(word)
            one, many = _UNIT_WORDS[letter]
            span = f"{n} {one if n == 1 else many}"
            return Win(spec={"from": "all", "to": f"now-{n}{letter}"}, phrase=f"opened more than {span} ago",
                       older=True)
    return None


# --------------------------------------------------------------------------- #
# Period atoms: one named period inside a bound or a range ("1 Sep", "September
# 2026", "Q3", "2024", "2026-09-14", "last month"), as (unit, year | None, a, b):
# ("day", y, month, day), ("month", y, month, 0), ("quarter", y, quarter, 0),
# ("year", y, 0, 0) or ("token", None, calendar token, 0).
# --------------------------------------------------------------------------- #
_Atom = tuple[str, Any, Any, int]
_ORDINAL = r"(?:st|nd|rd|th)?"
_ATOM_FORMS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"(\d{4})-(\d{2})-(\d{2})"), "iso_day"),
    (re.compile(r"(\d{4})-(0[1-9]|1[0-2])"), "iso_month"),
    (re.compile(rf"(\d{{1,2}}){_ORDINAL}\s+(?:of\s+)?({_MONTH_WORD})\.?(?:,?\s+(20\d\d))?"), "day_month"),
    (re.compile(rf"({_MONTH_WORD})\.?\s+(\d{{1,2}}){_ORDINAL}(?:,?\s+(20\d\d))?"), "month_day"),
    (re.compile(rf"({_MONTH_WORD})\.?(?:\s+(?:of\s+)?(20\d\d))?"), "month"),
    (re.compile(r"q([1-4])(?:\s*[- ]?\s*(20\d\d))?"), "quarter"),
    (re.compile(r"(20\d\d)\s*[- ]?\s*q([1-4])"), "year_quarter"),
    (re.compile(r"(20\d\d)"), "year"),
    (re.compile(r"(?:the\s+)?(today|yesterday|(?:this|last|previous) (?:week|month|quarter|year))"), "token"),
)


def _valid_day(year: int | None, month: int, day: int) -> bool:
    if not 1 <= month <= 12:
        return False
    return 1 <= day <= calendar.monthrange(year or 2024, month)[1]


def _atom(text: str) -> _Atom | None:
    """``text`` (the whole of it) as one period atom, else None."""
    text = re.sub(r"^(?:the\s+)", "", text.strip(" ,.?!;:'\""))
    for pattern, form in _ATOM_FORMS:
        match = pattern.fullmatch(text)
        if not match:
            continue
        g = match.groups()
        if form == "iso_day":
            y, m, d = int(g[0]), int(g[1]), int(g[2])
            return ("day", y, m, d) if _valid_day(y, m, d) else None
        if form == "iso_month":
            return "month", int(g[0]), int(g[1]), 0
        if form in ("day_month", "month_day"):
            day, word = (g[0], g[1]) if form == "day_month" else (g[1], g[0])
            year = int(g[2]) if g[2] else None
            month = _MONTH_NUMBERS[word]
            return ("day", year, month, int(day)) if _valid_day(year, month, int(day)) else None
        if form == "month":
            return "month", int(g[1]) if g[1] else None, _MONTH_NUMBERS[g[0]], 0
        if form == "quarter":
            return "quarter", int(g[1]) if g[1] else None, int(g[0]), 0
        if form == "year_quarter":
            return "quarter", int(g[0]), int(g[1]), 0
        if form == "year":
            return "year", int(g[0]), 0, 0
        token = g[0].replace("previous", "last").replace(" ", "_")
        return "token", None, token, 0
    return None


def _atom_prefix(text: str, max_words: int = 4) -> _Atom | None:
    """The longest leading run of up to ``max_words`` words of ``text`` that is one atom."""
    words = text.strip().split()
    for size in range(min(max_words, len(words)), 0, -1):
        found = _atom(" ".join(words[:size]))
        if found is not None:
            return found
    return None


def _atom_suffix(text: str, max_words: int = 4) -> _Atom | None:
    """The longest trailing run of up to ``max_words`` words of ``text`` that is one atom."""
    words = text.strip().split()
    for size in range(min(max_words, len(words)), 0, -1):
        found = _atom(" ".join(words[-size:]))
        if found is not None:
            return found
    return None


def _atom_month(atom: _Atom) -> int:
    """The first calendar month an atom covers (for year inference and ordering)."""
    unit, _year, a, _b = atom
    if unit in ("day", "month"):
        return int(a)
    if unit == "quarter":
        return (int(a) - 1) * 3 + 1
    return 1


def _atom_needs_year(atom: _Atom) -> bool:
    return atom[0] in ("day", "month", "quarter") and atom[1] is None


def _with_year(atom: _Atom, year: int) -> _Atom:
    return atom[0], year, atom[2], atom[3]


def _latest_year(atom: _Atom, anchor: tuple[int, int]) -> int:
    """The year of the most recent such period that has started by the anchor month."""
    return anchor[0] if _atom_month(atom) <= anchor[1] else anchor[0] - 1


def _atom_literal(atom: _Atom) -> str:
    """A dated atom as the bound the tools take: a day, a month, a quarter or a year
    literal, or a calendar token (a ``from`` bound takes its start, a ``to`` its end)."""
    unit, year, a, b = atom
    if unit == "day":
        return f"{year:04d}-{a:02d}-{b:02d}"
    if unit == "month":
        return f"{year:04d}-{a:02d}"
    if unit == "quarter":
        return f"{year:04d}-Q{a}"
    if unit == "year":
        return f"{year:04d}"
    return str(a)


def _atom_phrase(atom: _Atom) -> str:
    unit, year, a, b = atom
    suffix = f" {year}" if year else ""
    if unit == "day":
        return f"{b} {_MONTH_SHORT[a - 1]}{suffix}"
    if unit == "month":
        return f"{_MONTH_LONG[a - 1]}{suffix}"
    if unit == "quarter":
        return f"Q{a}{suffix}"
    if unit == "year":
        return str(year)
    return str(a).replace("_", " ")


def _atom_step(atom: _Atom, step: int) -> _Atom:
    """The period ``step`` (±1) after a dated atom: the day, month, quarter or year
    before or after it."""
    unit, year, a, b = atom
    if unit == "day":
        moved = date(year, a, b) + timedelta(days=step)
        return "day", moved.year, moved.month, moved.day
    if unit == "month":
        index = year * 12 + (a - 1) + step
        return "month", index // 12, index % 12 + 1, 0
    if unit == "quarter":
        index = year * 4 + (a - 1) + step
        return "quarter", index // 4, index % 4 + 1, 0
    return "year", year + step, 0, 0


def _atom_span(start: _Atom, end: _Atom) -> int | None:
    """Hours from the start of ``start`` to the end of ``end`` (both dated literals)."""
    def first(atom: _Atom) -> date:
        unit, year, a, b = atom
        return date(year, a, b) if unit == "day" else date(year, _atom_month(atom), 1)

    def last(atom: _Atom) -> date:
        unit, year, a, b = atom
        if unit == "day":
            return date(year, a, b)
        month = {"month": a, "quarter": a * 3, "year": 12}[unit]
        return date(year, month, calendar.monthrange(year, month)[1])

    if start[0] == "token" or end[0] == "token":
        return None
    days = (last(end) - first(start)).days + 1
    return days * 24 if days > 0 else None


def _range_win(lead: str, a: _Atom, b: _Atom, anchor: tuple[int, int] | None) -> Win | None:
    """"from A to B" / "between A and B" as one range ``{"from", "to"}`` (dated from
    ``anchor`` when neither end names its year)."""
    if a[0] == "token" or b[0] == "token":
        return None
    if _atom_needs_year(a) and _atom_needs_year(b):
        if anchor is None:
            return Win(spec=None, phrase=f"{_atom_phrase(a)} to {_atom_phrase(b)}", pending=("range", (a, b)))
        a = _with_year(a, _latest_year(a, anchor))
    if _atom_needs_year(a):
        a = _with_year(a, b[1] if _atom_month(a) <= _atom_month(b) else b[1] - 1)
    if _atom_needs_year(b):
        b = _with_year(b, a[1] if _atom_month(b) >= _atom_month(a) else a[1] + 1)
    if (a[1], _atom_month(a), a[3]) > (b[1], _atom_month(b), b[3]):
        a, b = b, a
    return Win(spec={"from": _atom_literal(a), "to": _atom_literal(b)},
               phrase=f"{_atom_phrase(a)} to {_atom_phrase(b)}", hours=_atom_span(a, b))


def _bound_win(word: str, atom: _Atom, anchor: tuple[int, int] | None, onwards: bool = False) -> Win | None:
    """One bound around a named period: "since March" (from its start), "after 2024"
    (from the next period), "before September" (to the end of the period before),
    "until Q3" (to its end), "from 2024" (that period, unless "onwards" follows)."""
    if _atom_needs_year(atom):
        if anchor is None:
            return Win(spec=None, phrase=f"{word} {_atom_phrase(atom)}", pending=("bound", (word, atom, onwards)))
        atom = _with_year(atom, _latest_year(atom, anchor))
    # The tools read a ``from`` that names a period on its own as that whole period, so
    # an open end is spelled out ("to": "now"), and an open start is "from": "all".
    if atom[0] == "token":
        token = str(atom[2])
        if word in ("since",) or word == "from" and onwards:
            return Win(spec={"from": token, "to": "now"}, phrase=f"since {_atom_phrase(atom)}")
        if word == "from":
            return _token_win(token)
        if word in ("until", "till", "up to"):
            return Win(spec={"from": "all", "to": token}, phrase=f"until the end of {_atom_phrase(atom)}")
        return None
    if word == "from" and not onwards:
        if atom[0] == "day":
            word = "since"
        else:
            return _atom_window(atom)
    if word in ("since", "from") and atom[0] == "month":
        return _since_win(atom[1], atom[2], anchor)
    if word in ("since", "from"):
        hours = None
        if anchor is not None:
            hours = _atom_span(atom, ("month", anchor[0], anchor[1], 0))
        spec: dict[str, Any] = {"from": _atom_literal(atom)}
        if atom[0] != "day":
            spec["to"] = "now"   # an ISO date alone already means "since then"
        return Win(spec=spec, phrase=f"since {_atom_phrase(atom)}", hours=hours)
    if word == "after":
        nxt = _atom_step(atom, 1)
        spec = {"from": _atom_literal(nxt)}
        if nxt[0] != "day":
            spec["to"] = "now"
        return Win(spec=spec, phrase=f"after {_atom_phrase(atom)}")
    if word in ("until", "till", "up to"):
        return Win(spec={"from": "all", "to": _atom_literal(atom)}, phrase=f"until the end of {_atom_phrase(atom)}")
    prev = _atom_step(atom, -1)
    return Win(spec={"from": "all", "to": _atom_literal(prev)}, phrase=f"before {_atom_phrase(atom)}")


def _atom_window(atom: _Atom) -> Win:
    """A dated atom as its own window ("September 2026", "Q3 2026", "2024", a day)."""
    unit, year, a, b = atom
    if unit == "month":
        return _month_win(year, a)
    if unit == "quarter":
        return _quarter_win(year, a)
    if unit == "year":
        return Win(spec=str(year), phrase=str(year), hours=8760, unit="year")
    literal = _atom_literal(atom)
    return Win(spec=literal, phrase=_day_phrase(literal), hours=24, unit="day")


def _named_range(low: str, anchor: tuple[int, int] | None = None) -> Win | None:
    """A range the question names: "between August and September", "from 1 Sep to
    15 Sep", "1 Sep to 15 Sep", "from Q2 to Q3 2026"."""
    for lead in _RANGE_LEAD_RE.finditer(low):
        rest = low[lead.end():]
        for join in _RANGE_JOIN_RE.finditer(rest):
            a = _atom(rest[:join.start()])
            if a is None:
                continue
            b = _atom_prefix(rest[join.end():])
            if b is not None:
                win = _range_win(lead.group(1), a, b, anchor)
                if win is not None:
                    return win
    if re.search(r"\bcompar\w*\b|\bvs\.?\b|\bversus\b", low):
        return None  # "compare August to September" is a comparison, not a range
    for join in _BARE_RANGE_JOIN_RE.finditer(low):
        a, b = _atom_suffix(low[:join.start()], 3), _atom_prefix(low[join.end():], 3)
        if a is not None and b is not None and a[0] in ("day", "month", "quarter") and b[0] == a[0]:
            win = _range_win("from", a, b, anchor)
            if win is not None:
                return win
    return None


def _named_bound(low: str, anchor: tuple[int, int] | None = None) -> Win | None:
    """A bound the question names ("since March", "before September", "after 2024")."""
    for bound in _BOUND_WORD_RE.finditer(low):
        rest = low[bound.end():]
        words = rest.split()
        for size in range(min(4, len(words)), 0, -1):
            atom = _atom(" ".join(words[:size]))
            if atom is None:
                continue
            tail = " ".join(words[size:])
            onwards = bool(_ONWARDS_RE.match(tail))
            word = bound.group(1)
            if "start of" in low[bound.start():bound.end()] or "beginning of" in low[bound.start():bound.end()]:
                word, onwards = "since", True
            elif "end of" in low[bound.start():bound.end()] and word in ("before", "until", "till", "up to"):
                word = "until"
            win = _bound_win({"prior to": "before", "earlier than": "before"}.get(word, word), atom, anchor,
                             onwards=onwards)
            if win is not None:
                return win
            break
    return None


_YEAR_SO_FAR_RE = re.compile(r"(?<![\w.:#/-])(20\d\d)\s+(?:so far|to date)\b")
#: A year named on its own ("End of year report 2025", "2024 annual report", "year in
#: review 2025"): never an id, a host or a port, and only beside a report or period
#: word, so a bare number elsewhere is not read as a year.
_BARE_YEAR_RE = re.compile(r"(?<![\w.:#/@-])(?<!\bport )(?<!\bpid )(?<!\bid )(?<!\bevent )(20\d\d)(?![\w.:/@-])")
_YEAR_CONTEXT_RE = re.compile(rf"\b(?:{_REPORT_NOUN}|annual|yearly|years?|fy|fiscal|calendar|period)\b")
#: A period token no rule read ("fy2025", a year with no report or period word near
#: it): an implied period or a report cadence must not replace it.
_UNREAD_PERIOD_TOKEN_RE = re.compile(r"(?<![\w.:#/@-])(?:fy\s?\d{2,4}|20\d\d)(?![\w.:/@-])")


def _window_from(lowered: str) -> Win | None:
    """The window the question names, or None (each lookup's own default applies).

    Explicit periods come first (a case-age bound, ISO ranges, named ranges and
    bounds, quarters, months, calendar phrases, rolling spans, all time, years, then a
    year named on its own beside a report or period word). A period token no rule reads
    ("fy2025") stops there: nothing implied replaces it. A period the question only implies ("a full-year report", "for the quarter") counts
    when nothing else names one, so "a full-year report for last year" covers last
    year. A report CADENCE word ("monthly report") only sets the window when nothing
    else does, so "monthly report for this month" covers this month."""
    win = _named_window(lowered)
    if win is not None:
        return win
    # A year the analyst named outranks a period they only implied: "End of year report
    # 2025" and "Make a full year report 2025" cover 2025, never this year.
    match = _BARE_YEAR_RE.search(lowered)
    if match and _YEAR_CONTEXT_RE.search(lowered):
        year = int(match.group(1))
        return Win(spec=str(year), phrase=str(year), hours=8760, unit="year")
    if _UNREAD_PERIOD_TOKEN_RE.search(lowered):
        # A period token no rule reads ("fy2025"): said in the answer as not read
        # (:func:`_loose_period`), never silently replaced by "this year".
        return None
    for pattern, token in (*_IMPLIED_PERIODS, *_CADENCE):
        if re.search(pattern, lowered):
            return _token_win(token)
    return None


#: "since 17 Oct 2026 12:23" (the dated form the planner's own chips use): from that
#: instant, in the operator time zone (an ISO ``from`` the tools read as local time).
_SINCE_DATED_CLOCK_RE = re.compile(
    rf"\bsince (\d{{1,2}}) ({_MONTH_WORD}) (\d{{4}}),? (?:at )?([01]?\d|2[0-3]):([0-5]\d)\b")
#: "since 14:10 today", "since today at 14:10", "since yesterday 18:40": a clock time
#: on a day the planner cannot date by itself (it has no clock), so the clock anchor
#: lookup (today's one-day bucket) dates it.
_SINCE_CLOCK_DAY_RE = re.compile(
    r"\bsince (?:(?P<pre>today|yesterday)(?: at)? )?(?P<h>[01]?\d|2[0-3]):(?P<m>[0-5]\d)(?: (?P<post>today|yesterday))?\b")


def _clock_bound(low: str) -> Win | None:
    """A "since" bound at a clock time (see the two patterns above), else None."""
    match = _SINCE_DATED_CLOCK_RE.search(low)
    if match:
        day, word, year, hour, minute = match.groups()
        month = _MONTH_NUMBERS.get(word[:4] if word.startswith("sept") else word)
        if month is None or not _valid_day(int(year), month, int(day)):
            return None
        stamp = f"{int(year):04d}-{month:02d}-{int(day):02d}T{int(hour):02d}:{minute}"
        return Win(spec={"from": stamp},
                   phrase=f"since {int(day)} {_MONTH_SHORT[month - 1]} {year} {int(hour):02d}:{minute}")
    match = _SINCE_CLOCK_DAY_RE.search(low)
    if match and (match.group("pre") or match.group("post")):
        back = 1 if "yesterday" in (match.group("pre"), match.group("post")) else 0
        hour, minute = int(match.group("h")), match.group("m")
        phrase = (f"since yesterday {hour:02d}:{minute}" if back else f"since {hour:02d}:{minute} today")
        return Win(spec=None, phrase=phrase, pending=("clock", (back, hour, int(minute))))
    return None


def _clocked(win: Win | None, today: date | None) -> Win | None:
    """A clock-time bound dated from today's date (the clock anchor's one-day bucket),
    or None when the anchor did not answer."""
    if win is None or win.pending is None or win.pending[0] != "clock":
        return win
    if today is None:
        return None
    back, hour, minute = win.pending[1]
    day = today - timedelta(days=back)
    return Win(spec={"from": f"{day.isoformat()}T{hour:02d}:{minute:02d}"}, phrase=win.phrase)


def _named_window(low: str) -> Win | None:
    """The period ``low`` names explicitly (no implied period, no report cadence)."""
    win = _age_window(low)
    if win is not None:
        return win
    win = _clock_bound(low)
    if win is not None:
        return win
    match = _ISO_RANGE_RE.search(low)
    if match:
        a, b = match.group(1), match.group(2)
        return Win(spec={"from": a, "to": b}, phrase=f"{_day_phrase(a)} to {_day_phrase(b)}",
                   hours=_atom_span(_atom(a) or ("token", None, "", 0), _atom(b) or ("token", None, "", 0)))
    for finder in (_named_range, _named_bound):
        win = finder(low)
        if win is not None:
            return win
    match = _ISO_DAY_RE.search(low)
    if match:
        return Win(spec=match.group(1), phrase=_day_phrase(match.group(1)), hours=24, unit="day")
    match = _QUARTER_YEAR_RE.search(low)
    if match:
        quarter = int(match.group(1) or match.group(4))
        year = int(match.group(2) or match.group(3))
        return _quarter_win(year, quarter)
    match = _MONTH_YEAR_RE.search(low)
    if match:
        word = re.match(_MONTH_WORD, match.group(0)).group(0)  # type: ignore[union-attr]
        return _month_win(int(match.group(1)), _MONTH_NUMBERS[word])
    match = _ISO_MONTH_RE.search(low)
    if match:
        return _month_win(int(match.group(1)), int(match.group(2)))
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
    # "2026 so far", "for the year 2025 to date": that year (to date while it runs), never
    # all time, which "so far" and "to date" alone mean.
    match = _YEAR_SO_FAR_RE.search(low)
    if match:
        year = int(match.group(1))
        return Win(spec=str(year), phrase=str(year), hours=8760, unit="year")
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


def _unread_window(lowered: str) -> str | None:
    """A time phrase the question names that :func:`_window_from` could not read
    ("before the outage last Tuesday", "for the fiscal year"): said in the answer, never
    dropped silently, so an answer never claims that no period was named."""
    for match in _DATE_CUE_RE.finditer(lowered):
        phrase = match.group(0).strip(" ,.;")
        if _DATE_WORD_RE.search(match.group(1)):
            return phrase
    match = _PERIOD_PHRASE_RE.search(lowered)
    if match:
        return match.group(0).strip(" ,.;")
    return None


def _token_win(token: str) -> Win:
    if token in _CALENDAR:
        phrase, hours, unit = _CALENDAR[token]
        return Win(spec=token, phrase=phrase, hours=hours, unit=unit)
    match = re.fullmatch(r"now-(\d+)([mhdwMy])", token)
    if match:
        return _relative(int(match.group(1)), match.group(2))
    return Win(spec=token, phrase=token)


def _anchored(win: Win | None, anchor: tuple[int, int] | None) -> Win | None:
    """A period named without its year, dated from ``anchor`` (the current year and
    month, read from the anchor lookup's latest calendar bucket): the most recent one
    that has started (a range starts at its first period; a bound uses its period)."""
    if win is None or win.pending is None:
        return win
    if anchor is None:
        return None
    year, month = anchor
    kind, payload = win.pending
    if kind == "quarter":
        current = (month - 1) // 3 + 1
        return _quarter_win(year if payload <= current else year - 1, payload)
    if kind == "range":
        a, b = payload
        return _range_win("from", a, b, anchor)
    if kind == "bound":
        word, atom, onwards = payload
        return _bound_win(word, atom, anchor, onwards=onwards)
    target = year if payload <= month else year - 1
    return _since_win(target, payload, anchor) if kind == "since" else _month_win(target, payload)


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
# "The month before", "the week prior", "the one before", "the 30 days before": the
# period just before.
_BEFORE_PERIOD = (r"the\s+(?:month|week|quarter|year|day|one|period|\d{1,4}\s+(?:hours|days|weeks|months|years))"
                  r"\s+(?:before|prior)\b")
_COMPARE_PREVIOUS_RE = re.compile(
    r"\b(?:vs\.?|versus|compared? (?:to|with)|against|than|relative to)\s+(?:the\s+)?(?:last|previous|prior|"
    r"preceding|earlier|month before|week before|quarter before)\b|"
    rf"\b(?:vs\.?|versus|compared? (?:to|with)|against|than|relative to|with|to|and)\s+{_BEFORE_PERIOD}|"
    # "Today vs yesterday", "compare today with yesterday": the day before.
    r"\b(?:vs\.?|versus|compared? (?:to|with)|against|than|relative to)\s+yesterday\b(?!'s)|"
    r"\bcompar\w*\b.*\b(?:with|to|and)\s+yesterday\b(?!'s)|"
    r"\b(?:month|week|quarter|year|day)[- ]over[- ](?:month|week|quarter|year|day)\b|\b(?:mom|wow|qoq)\b|"
    r"\bcompared? (?:this|the current|our)\b|\bchanged? (?:since|from) (?:last|the previous)\b|"
    r"\bbetter or worse\b|\bimprov(?:ed|ing) (?:since|from|over)\b|"
    # "Is MTTR improving?", "Are we getting worse?": the current period against the one before.
    r"\b(?:improv(?:ing|ed)|getting (?:better|worse)|got (?:better|worse)|worsen(?:ing|ed)|"
    r"declin(?:ing|ed)|regress(?:ing|ed)|deteriorat(?:ing|ed))\b|"
    r"\bcompar\w*\b.*\b(?:with|to|against)\s+(?:the\s+)?(?:last|previous|prior|preceding)\b")
_COMPARE_STRIP_RE = re.compile(
    r"\b(?:vs\.?|versus|compared? (?:to|with)|against|than|relative to)\b.*$|"
    r"\b(?:with|to)\s+(?:the\s+)?(?:last|previous|prior|preceding|same)\b.*$|"
    rf"\b(?:with|to|and)\s+{_BEFORE_PERIOD}.*$|"
    r"\b(?:with|to|and)\s+yesterday\b.*$|"
    # "Changed since last week": the named period is the BASELINE, not the subject.
    r"\b(?:since|from)\s+(?:the\s+)?(?:last|previous|prior)\b.*$")


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
        # "Better or worse than last month?" and "changed since last week?" compare
        # THIS period with the named one: the named period is the baseline.
        spec = win.spec if win is not None else None
        token = spec if isinstance(spec, str) else (
            spec.get("from") if isinstance(spec, dict) and set(spec) <= {"from", "to"}
            and spec.get("to") in (None, "now") else None)
        if isinstance(token, str) and token.startswith("last_") and token.replace("last_", "this_") in _CALENDAR:
            win = _token_win(token.replace("last_", "this_"))
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
    hours = win.hours
    if hours is None:
        # An open or unknown span ("since 2024", "until 31 Aug"): the tool picks the
        # finest calendar unit that keeps the chart readable.
        return "auto"
    if hours <= 48:
        return "hour"
    if hours <= 24 * 45:
        return "day"
    if hours <= 24 * 200:
        return "week"
    return "month"


#: Case groupings (``case_stats group_by``) by the words that ask for them.
_CASE_GROUP_WORDS: tuple[tuple[str, str], ...] = (
    # A named person is the ASSIGNEE: the case store records who a case is assigned
    # to, not which analyst pressed close ("closed_by" is the decider type).
    (r"\b(?:by|per|across|for each) (?:assignee|analyst|owner|person)s?\b|\bwho (?:is|are) (?:assigned|working)\b|"
     r"\bassigned to (?:whom|who)\b|\bwhich analysts?\b|\bper analyst\b|\banalyst workload\b", "assignee"),
    (r"\bwho (?:closed|resolved)\b|\bclosed (?:the )?most\b|\b(?:by|per) (?:closer|who closed)\b|"
     r"\bclosed by (?:analyst|whom|who)\b", "closed_by"),
    (r"\b(?:by|per|across|for each) severit(?:y|ies)\b|\bseverity (?:breakdown|split|mix)\b", "severity"),
    (r"\b(?:by|per|across|for each) (?:status|state)(?:es)?\b|\bstatus (?:breakdown|split|mix)\b", "status"),
    (r"\b(?:by|per|across|for each) verdicts?\b|\bverdict (?:breakdown|split)\b", "verdict"),
    (r"\b(?:by|per|across|for each) priorit(?:y|ies)\b", "priority"),
    (r"\b(?:by|per|across|for each) (?:detection )?rules?\b|\b(?:top|noisiest)(?: \d{1,2})? (?:detection )?rules\b|"
     r"\bwhich(?: \d{1,2})? rules?\b", "rule"),
    (r"\b(?:by|per|across|for each) (?:log )?sources?\b|\bwhich sources?\b", "source"),
    (r"\b(?:by|per|across|for each) (?:disposition|classification)s?\b", "disposition"),
    (r"\b(?:by|per|across|for each) (?:att&ck |mitre )?tactics?\b", "mitre_tactic"),
    (r"\b(?:by|per|across|for each) (?:att&ck |mitre )?techniques?\b", "mitre_technique"),
    (r"\b(?:decided by|who decided|by decision maker)\b", "decided_by"),
    (r"\bopen (?:vs\.?|versus|and) closed\b", "status_group"),
)
#: The same groupings in the "<field> wise" phrasing ("segregate the open cases
#: severity wise", "status-wise", "segregate them on rule"). "Month wise" and the other
#: calendar units are a creation-time bucket instead (:data:`_BUCKET_WORDS`).
_FIELD_WISE_WORDS: tuple[tuple[str, str], ...] = (
    (r"assignee|analyst|owner", "assignee"),
    (r"severit(?:y|ies)", "severity"),
    (r"status", "status"),
    (r"verdict", "verdict"),
    (r"priorit(?:y|ies)", "priority"),
    (r"(?:detection )?rule", "rule"),
    (r"(?:log )?source", "source"),
    (r"disposition|classification", "disposition"),
    (r"(?:att&ck |mitre )?tactic", "mitre_tactic"),
    (r"(?:att&ck |mitre )?technique", "mitre_technique"),
)
_SEGREGATE_ON = (r"(?:on the basis of|on basis of|with respect to|w\.?r\.?t\.?|with regard to|in accordance with|"
                 r"depending on|on|into|in terms of|according to|as per|based on|by|per)")
_CASE_GROUP_WORDS = _CASE_GROUP_WORDS + tuple(
    (rf"\b(?:{words})[- ]?wise\b|\bsegregat\w* (?:\w+ ){{0,4}}?{_SEGREGATE_ON} (?:the |their |its )?(?:{words})"
     r"(?:s|es|ies)?\b", fld)
    for words, fld in _FIELD_WISE_WORDS)


def _case_group_from(lowered: str) -> str | None:
    return next((fld for pattern, fld in _CASE_GROUP_WORDS if re.search(pattern, lowered)), None)


#: A grouping word after "by" (or after "and" that follows one): the case field.
_GROUP_WORD_FIELDS = {
    "severity": "severity", "severities": "severity", "status": "status", "statuses": "status",
    "state": "status", "verdict": "verdict", "verdicts": "verdict", "priority": "priority",
    "priorities": "priority", "rule": "rule", "rules": "rule", "source": "source", "sources": "source",
    "assignee": "assignee", "assignees": "assignee", "analyst": "assignee", "analysts": "assignee",
    "owner": "assignee", "owners": "assignee", "tactic": "mitre_tactic", "tactics": "mitre_tactic",
    "technique": "mitre_technique", "techniques": "mitre_technique", "disposition": "disposition",
    "dispositions": "disposition",
}
_BY_AND_RE = re.compile(r"\b(?:by|per)\s+([a-z]+)(?:\s+(?:and|&|then)\s+(?:by\s+)?([a-z]+))?")


def _named_groups(lowered: str) -> list[str]:
    """The case fields named after "by" ("by severity and assignee"), in order."""
    found: list[str] = []
    for match in _BY_AND_RE.finditer(lowered):
        for word in match.groups():
            fld = _GROUP_WORD_FIELDS.get(word or "")
            if fld and fld not in found:
                found.append(fld)
    return found


#: The ranking length a question asks for: "top 5 rules", "which 3 hosts", "explain the
#: first 3 (cases)", "the 5 riskiest cases", "the 3 most recent incidents". "The first
#: 3 days" and "the 7 most recent days" are spans of time, never a length.
_TOP_N_RE = re.compile(
    r"\b(?:top|which)[- ](\d{1,3})\b"
    r"|\bfirst\s+(\d{1,3})(?=\s*(?:[,.?!;:]|$)|\s+(?:by|ones)\b|\s+" + _RECORD_QUALIFIERS
    + r"(?:cases|incidents|tickets|investigations|escalations|alerts|detections|(?:true|false)[- ]positives|hosts|"
    r"machines|servers|endpoints|users|accounts|ips|rules|results|findings|rows|matches)\b)"
    r"|\b(\d{1,3})\s+(?:most\s+|least\s+)?(?:riskiest|risky|highest[- ]risk|lowest[- ]risk|most critical|"
    r"newest|latest|oldest|recent|worst|biggest|noisiest|busiest|loudest)\b"
    r"(?!\s+(?:[a-z-]+\s+)?(?:seconds?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|quarters?|years?)\b)")


def _top_n(lowered: str, default: int = 10) -> int:
    """"Top 5 rules": the ranking length asked for (1..50, the tools' bound)."""
    match = _TOP_N_RE.search(lowered)
    if match is None:
        return default
    return max(1, min(50, int(next(g for g in match.groups() if g))))


#: The AI agent (or automation) closing cases: "auto-closed", "closed automatically",
#: "did the AI close".
_AUTO_CLOSE_RE = re.compile(
    r"\bauto[- ]?clos\w*|\bclosed automatically\b|\bautomatically closed\b|"
    r"\b(?:the )?(?:ai|agent|agents|model|llm)\b(?:\s+\w+){0,2}?\s+(?:close|closed|closes|resolve|resolved|"
    r"resolves)\b")
#: A question for a share rather than a count ("what percentage", "what share",
#: "what proportion", "how much of"). "Share" counts only as the noun ("what share of",
#: "the share"), never the verb ("share the auto-closed cases with me" wants the cases).
_SHARE_CUE_RE = re.compile(
    r"\b(?:percent(?:age)?s?|proportion|fraction|ratio|how much of)\b|%|"
    r"\b(?:what|which|the|a|their|its)\s+(?:\w+\s+)?share\b|\bshare\s+of\b")
#: Spend words: a share of the cost or budget is a cost question, never a case share.
_COST_WORD_RE = re.compile(r"\b(?:cost|costs|spend|spent|spending|tokens?|budget|billing|money)\b|\$")
#: "What percentage of the auto-closed cases were false positives?": a share WITHIN
#: the cases the AI agent closed (group 1 names the part), not the automation rate.
_SHARE_WORD = r"(?:\b(?:percent(?:age)?|proportion|fraction|ratio|share|how much|how many)|%)"
_AUTO_CLOSED_SET = (r"(?:the\s+|all\s+|our\s+|those\s+|these\s+)?(?:(?:auto[- ]?closed|automatically closed|"
                    r"ai[- ]closed|closed automatically)\s*(?:cases?|incidents?|ones)?|(?:cases?|incidents?|ones)\s+"
                    r"(?:that\s+)?(?:the\s+)?(?:ai|agent|model|llm|automation)\s+(?:auto[- ]?)?(?:closed|resolved))")
#: A few qualifier words between the set and its verb ("… auto-closed cases this month
#: were …", "… the cases the AI closed last week were …").
_WITHIN_QUALIFIERS = r"(?:\s+(?!(?:were|are|was|is)\b)[\w'-]+){0,4}?"
_WITHIN_VERB_AND_PART = (r"\s+(?:were|are|was|is|got|had|have)\s+(?:(?:a|an|the|marked|marked as|rated|"
                         r"classified as|labell?ed|labell?ed as|deemed|actually|really)\s+)*([a-z].*)$")
_WITHIN_AUTO_CLOSED_RES: tuple[re.Pattern[str], ...] = (
    # "What percentage of the auto-closed cases (this month) were medium severity?"
    re.compile(_SHARE_WORD + r"\s+of\s+" + _AUTO_CLOSED_SET + _WITHIN_QUALIFIERS + _WITHIN_VERB_AND_PART),
    # "Of the auto-closed cases, what percentage were false positives?"
    re.compile(r"\bof\s+" + _AUTO_CLOSED_SET + _WITHIN_QUALIFIERS + r"\s*,?\s+(?:what|which)\s+(?:\w+\s+)?"
               + _SHARE_WORD + r"(?:\s+of\s+(?:them|those|these))?" + _WITHIN_VERB_AND_PART),
)
_WITHIN_PARTS: tuple[tuple[str, str, str, str], ...] = (
    (r"false[- ]positives?|fps?|benign", "verdict", "FALSE_POSITIVE", "false positives"),
    (r"true[- ]positives?|tps?|malicious|real (?:threats?|incidents?|attacks?)", "verdict", "TRUE_POSITIVE",
     "true positives"),
    (r"needs?[- ]human|needing a human", "verdict", "NEEDS_HUMAN", "marked needs human"),
    (r"critical(?: severity)?", "severity", "critical", "critical"),
    (r"high(?: severity)?", "severity", "high", "high severity"),
    (r"medium(?: severity)?", "severity", "medium", "medium severity"),
    (r"low(?: severity)?", "severity", "low", "low severity"),
)


def _within_auto_closed(lowered: str) -> tuple[str, str, str] | None:
    """``(field, value, words)`` for a share within the AI's closes ("what % of the
    auto-closed cases were false positives" is ``("verdict", "FALSE_POSITIVE",
    "false positives")``); ``("", "", "")`` when the part is not one chat can count."""
    match = next((m for m in (p.search(lowered) for p in _WITHIN_AUTO_CLOSED_RES) if m is not None), None)
    if match is None:
        return None
    part = match.group(1).strip()
    for pattern, group, value, words in _WITHIN_PARTS:
        if re.match(rf"(?:{pattern})\b", part):
            return group, value, words
    return "", "", ""
#: "Which users had the most cases?", "cases per host": cases counted by the entity
#: each one is recorded against (never by log events).
_ENTITY_CASES_RE = re.compile(
    r"\b(users?|accounts?|hosts?|machines?|servers?|endpoints?|ips?|ip addresses)\b(?:\s+[a-z']+){0,4}?\s+"
    r"(?:the\s+)?(?:most|highest number of|largest number of)\s+(?:\w+\s+)?(?:cases|incidents)\b|"
    r"\b(?:cases|incidents)\s+(?:by|per)\s+(user|account|host|machine|server|endpoint|ip)s?\b")
_ENTITY_KIND = {"user": "user", "account": "user", "host": "host", "machine": "host", "server": "host",
                "endpoint": "host", "ip": "ip"}


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


def _console_entity_ask(ask: Callable[..., Ask], kind: str, value: str) -> Ask:
    """Round 12 WP-ASK: the plan for an "Ask AI" chip's question about one value — an
    in-depth look at an IP, host or user; a case's investigation; a rule's cases by
    verdict (its ``detection rule`` filter, :func:`_case_rule`); cases and sightings of
    any other indicator. ``no_lookup``: the value is not the analyst's own words."""
    if kind == "case":
        return ask("case", case_id=value, no_lookup=True)
    if kind in ("ip", "host", "user"):
        return ask("deep", entity=(kind, value), no_lookup=True)
    if kind == "rule":
        return ask("breakdown", group="verdict", no_lookup=True)
    return ask("hunt", indicator=(value, kind), no_lookup=True)


#: "detection rule demo_rdp_bruteforce", "the detection rule `web_portal_auth`": the
#: rule a case question names (one identifier token; the case store's ``rule`` filter).
_CASE_RULE_RE = re.compile(r"\bdetection rule\s+[\"'`]?([A-Za-z0-9_][\w.:/@#+$\\-]{0,255}?)[\"'`]?(?=[\s,;:?!]|\.?$)",
                           re.IGNORECASE)


def _case_rule(question: str) -> str | None:
    match = _CASE_RULE_RE.search(question)
    if not match:
        return None
    value = match.group(1).rstrip(".")
    return value if value and value.lower() not in _DEEP_STOP else None


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
        # "Alerts severity wise", "host-wise": the field named before "wise" (exactly,
        # so "otherwise" and "likewise" name nothing).
        fields = dict(_GROUP_FIELDS)
        return next((fields[m.group(1)] for m in re.finditer(r"\b((?:source |src )?[a-z]+)[- ]?wise\b", lowered)
                     if m.group(1) in fields), None)
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
    r"exec summary|(?:daily|weekly|monthly|quarterly|annual|yearly) (?:summary|digest|review|recap|rundown))\b")
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
    elif template is None and re.search(r"\b(performance|lifetime)\b|\b(?:daily|weekly|quarterly|annual|yearly) "
                                         r"(?:summary|digest|review|recap|rundown)\b", lowered):
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
    for cut in _LOG_TERM_CLAUSE_RE.finditer(term, quoted.end() if quoted else 0):
        between = term.lower().rfind("between", 0, cut.start())
        if between >= 0 and cut.group(0).strip().lower() == "and" and _is_window_phrase(term[between:]):
            continue  # "between 1 Sep and 15 Sep" is one window, not two clauses
        return term[:cut.start()], term[cut.end():]
    return term, ""


#: Words a window phrase is made of (besides month names, quarters, years, ISO dates
#: and numbers that count a unit or a day of a month).
_WINDOW_VOCAB = frozenset({
    "in", "over", "for", "during", "within", "across", "on", "of", "the", "last", "past", "previous", "prior",
    "trailing", "recent", "this", "current", "since", "from", "after", "before", "until", "till", "up", "to",
    "between", "and", "through", "thru", "all", "time", "all-time", "alltime", "lifetime", "ever", "entire",
    "whole", "history", "so", "far", "date", "ytd", "mtd", "qtd", "year", "years", "quarter", "quarters", "month",
    "months", "week", "weeks", "day", "days", "hour", "hours", "minute", "minutes", "mins", "min", "hrs", "hr",
    "today", "yesterday", "overnight", "morning", "start", "beginning", "end", "onwards", "onward", "now",
    "to-date", "a", "an", "one", "few", "older", "than", "more", "ago", "old", "at", "least",
})
_UNIT_TOKEN_RE = re.compile(r"^(?:minutes?|mins?|hours?|hrs?|h|days?|d|weeks?|wks?|w|months?|mos?|years?|yrs?|y)$")
_MONTH_TOKEN_RE = re.compile(rf"^{_MONTH_WORD}\.?$")


def _window_token_ok(words: Sequence[str], index: int) -> bool:
    """``words[index]`` can belong to a window phrase (in its neighbours' context)."""
    word = words[index].strip(",.?!;:'\"")
    nxt = words[index + 1].strip(",.?!;:") if index + 1 < len(words) else ""
    prev = words[index - 1].strip(",.?!;:") if index else ""
    if word in _WINDOW_VOCAB or _MONTH_TOKEN_RE.match(word) or re.fullmatch(r"q[1-4]|20\d\d", word):
        return True
    if re.fullmatch(r"\d{4}-\d{2}(?:-\d{2})?", word):
        return True
    if re.fullmatch(r"\d{1,2}(?:st|nd|rd|th)?", word) and (_MONTH_TOKEN_RE.match(nxt) or nxt == "of"
                                                           or _MONTH_TOKEN_RE.match(prev)):
        return True
    return bool(re.fullmatch(r"\d{1,4}", word) and _UNIT_TOKEN_RE.match(nxt))


def _is_window_phrase(text: str) -> bool:
    """``text`` is a window phrase and nothing else ("in October", "over all time",
    "since March", "this quarter", "between 1 Sep and 15 Sep")."""
    words = text.lower().split()
    if not words or not all(_window_token_ok(words, i) for i in range(len(words))):
        return False
    if len(words) == 1 and re.fullmatch(r"(?:jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)\.?", words[0]):
        return False  # a lone "SEP" or "dec" is a value to search for, not a month
    return _window_from(" ".join(words)) is not None


def _strip_window_tail(text: str) -> str:
    """``text`` without the window phrase it ends with ("mimikatz in September" is
    "mimikatz"), the longest such phrase first; a value is never stripped to nothing."""
    words = text.split()
    for start in range(1, len(words)):
        if _is_window_phrase(" ".join(words[start:])):
            return " " + " ".join(words[:start])
    return text


def _log_term_strip(text: str) -> tuple[str, str | None]:
    """``text`` without its trailing window, "by <field>" grouping and "please", in
    either order: ``(value, group field)``. The window is any the planner reads (a
    rolling span, a named month or quarter, a year, "since X", "all time"), so its
    words never end up in the searched value."""
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
        text = _strip_window_tail(_LOG_TERM_WINDOW_RE.sub("", text))
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
    rest = (match.groupdict().get("rest") or "").strip()
    if rest and not _is_window_phrase(rest):
        return None  # "search for X in the logs <something else>": not a plain log search
    template, _headings = _report_request(question.lower())
    if template not in (None, "custom"):
        return None
    head, tail = _log_term_split(match.group("term").strip())
    head, group = _log_term_strip(head)
    log_filter: _LogFilter | None
    if not head or _LOG_WINDOW_ONLY_RE.match(head) or _is_window_phrase(head):
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
        if (value and not _LOG_WINDOW_ONLY_RE.match(value) and not _is_window_phrase(value)
                and not _LOG_TAIL_VERB_RE.match(value)):
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


#: Things chat would have to WRITE: a request to create one is a change, whatever
#: words follow ("Create a review task", "Create a dashboard with the alert trend").
_WRITE_NOUN_RE = re.compile(
    r"^(?:tasks?|tickets?|dashboards?|rules?|suppressions?|watchlists?|allowlists?|blocklists?|notes?|comments?|"
    r"cases?|incidents?|assignments?|playbooks?|runbooks?|polic(?:y|ies)|exceptions?|users?|accounts?|channels?|"
    r"roles?|webhooks?|integrations?|alerts?|views?|filters?|schedules?|jobs?|sources?|connectors?|keys?|"
    r"secrets?|tags?|labels?|memor(?:y|ies)|proposals?|approvals?)$")
#: List-like write objects: "a suppression list", "an allow list", "a watch list".
_WRITE_LIST_RE = re.compile(r"\b(?:suppression|allow|block|deny|watch|exception|exclusion|ip|domain|hash)[- ]?lists?\b")
#: Where the verb's direct object ends: "a report OF lifetime performance".
_OBJECT_END_RE = re.compile(r"\b(?:of|for|on|about|with|from|in|over|by|to|that|which|showing|covering|"
                            r"listing|comparing|including|across|per|during|since|between|as)\b")


def _is_change(low: str) -> bool:
    """A request to change something (chat is read-only). Asking to create, make,
    build or generate a report, chart, table or breakdown is not one (SPEC D9); the
    answer word must be the head of the verb's direct object ("a PDF report of the
    cases", "me a chart"), so "Create a review task" and "Create a dashboard with the
    alert trend" stay changes chat cannot make."""
    if not _CHANGE_RE.match(low) or low.startswith(("show", "list", "summar")):
        return False
    if _RESPONSE_VERB_RE.match(low) and _acting(low) is None:
        # "Block events from 203.0.113.7", "isolate the root cause", "isolate host
        # srv-db-01: what else did it talk to?": the verb asks to read, not to change.
        return False
    verb = _ANSWER_VERB_RE.match(low)
    if verb is None:
        return True
    rest = low[verb.end():]
    cut = _OBJECT_END_RE.search(rest)
    obj = rest[:cut.start()] if cut else rest
    if _WRITE_LIST_RE.search(obj):
        return True
    words = [w for w in re.findall(r"[a-z][a-z&'-]*", obj)
             if w not in {"me", "us", "a", "an", "the", "our", "my", "some", "new", "quick", "short", "full"}]
    if not words:
        return True
    head = words[-1]
    if _ANSWER_OBJECT_RE.fullmatch(head):
        return False
    return True


def _out_of_scope(low: str) -> str | None:
    """``"code"`` or ``"creative"`` for a request chat is not for (final review L4):
    the head of the verb's direct object must be code ("a python script to scan my
    network", "code"), so "Create a case for the bot activity" stays a change and
    "Write a report" stays a report."""
    code = _CODE_ASK_RE.match(low)
    if code is not None:
        rest = code.group("rest")
        cut = _OBJECT_END_RE.search(rest)
        if _CODE_NOUN_RE.search(rest[:cut.start()] if cut else rest):
            return "code"
    creative = _CREATIVE_RE.match(low)
    if creative is not None:
        rest = creative.group("rest")
        # "Make up a story" is fiction whatever it is about.
        made_up = re.search(r"\bmake up\b", low[:creative.start("rest")]) is not None
        if creative.group("story") and not made_up and (_SOC_SUBJECT_RE.search(rest) or _CASE_ID_RE.search(rest)
                                        or _IPV4_RE.search(rest) or _DOMAIN_RE.search(rest)
                                        or _HASH_RE.search(rest)):
            return None   # "a story of case-abc123": a question about the analyst's data
        return "creative"
    return None


def _acting(low: str) -> re.Match[str] | None:
    """The response verb that opens ``low`` when the analyst asks to act with it; None
    for a noun use ("lock-out events"), a read object ("isolate the root cause",
    "isolate the cases for host dc01"), the issue of a case record ("contain the issue
    with case-abc123") or a question asked after it ("contain the damage: which hosts
    are affected?"). "Contain the damage now" and "contain the issue on host srv-db-01"
    ask to act."""
    action = _RESPONSE_VERB_RE.match(low)
    if action is None:
        return None
    rest = action.group("rest")
    if _RESPONSE_NOUN_USE_RE.match(rest):
        return None
    if action.group("verb") in ("isolate", "contain"):
        if _RESPONSE_READ_OBJECT_RE.match(rest):
            return None
        clause = _first_clause(rest)
        if (_RESPONSE_FIGURATIVE_RE.match(rest) and (_RECORD_REF_RE.search(clause) or _CASE_ID_RE.search(clause))
                and not _names_target(clause)):
            return None
    question = _LATER_QUESTION_RE.search(rest)
    if question is not None:
        # The question is the ask unless the verb's own clause names what to act on:
        # "isolate host srv-db-01: what else did it talk to?" still asks to isolate it.
        head = rest[:question.start()]
        if not (_RESPONSE_OBJECT_RE.search(head) or _IPV4_RE.search(head) or _HASH_RE.search(head)
                or _URL_RE.search(head) or _DOMAIN_RE.search(head)):
            return None
    return action


def _names_target(clause: str) -> bool:
    """Does a response verb's clause name what to act on (a host, an address, …)?"""
    return bool(_RESPONSE_OBJECT_RE.search(clause) or _IPV4_RE.search(clause) or _HASH_RE.search(clause)
                or _URL_RE.search(clause) or _DOMAIN_RE.search(clause))


def _is_response_action(q: str, low: str) -> bool:
    """A response action (isolate a host, block an IP, quarantine a file, kill a
    process): something no part of this console does (final review L4). "Kill the
    export job" acts on a console object, so it stays a change chat cannot make."""
    action = _acting(low)
    if action is None:
        # "Add 203.0.113.7 to the block list": a firewall's list, not a console one.
        return bool(_RESPONSE_LIST_RE.search(low)) and _is_change(low)
    rest = action.group("rest")
    indicator = bool(_IPV4_RE.search(q) or _HASH_RE.search(q) or _URL_RE.search(q) or _DOMAIN_RE.search(rest))
    if _CONSOLE_OBJECT_RE.search(_first_clause(rest)) and not indicator:
        return False
    return action.group("verb") in _RESPONSE_STRONG or indicator or bool(_RESPONSE_OBJECT_RE.search(rest))


def _first_clause(text: str) -> str:
    """The verb's own clause: "host srv-db-01" of "host srv-db-01 and build a report",
    so a later request's noun never decides what the first verb acts on."""
    return re.split(r"\b(?:and|then|but|also)\b|[,;.!?]", text, maxsplit=1)[0]


#: Words that follow "host" or "user" in a response request without naming one.
_TARGET_STOP = frozenset({
    "of", "out", "now", "to", "on", "at", "by", "off", "up", "down", "into", "onto", "from", "as", "so", "then",
    "immediately", "temporarily", "permanently", "right", "asap", "today", "tonight", "again", "first", "quickly",
    "too", "also", "please", "fully", "completely", "entirely", "here", "there", "which", "who", "whose",
    "involved", "affected", "compromised", "infected", "responsible", "behind",
})
#: Words that join a kind word to its name: "the account OF dsingh", "a host NAMED web01".
_TARGET_LINK = frozenset({"of", "named", "called"})
#: Words that never name a host or user after a kind word: determiners, pronouns,
#: function words and the generic nouns of a description ("the host of the attacker").
_TARGET_NOT_NAME = frozenset({
    "the", "a", "an", "this", "that", "these", "those", "its", "his", "her", "their", "our", "my", "your",
    "it", "them", "him", "me", "us", "we", "they", "you", "and", "or", "but", "nor", "if", "is", "are", "was",
    "were", "be", "been", "has", "have", "had", "do", "does", "did", "will", "would", "should", "can", "could",
    "may", "might", "must", "not", "no", "any", "some", "all", "every", "each", "what", "when", "where", "why",
    "how", "with", "without", "in", "for", "after", "before", "until", "while", "because", "via", "using",
    "attacker", "attackers", "adversary", "victim", "intruder", "hacker", "culprit", "suspect", "actor",
    "threat", "source", "target", "owner", "one", "ones", "same", "other", "others", "list",
})
_NEXT_TOKEN_RE = re.compile(r"\s+[\"'`]?([A-Za-z0-9][A-Za-z0-9._@\\-]{1,62})[\"'`]?")


_USER_KIND_WORDS = frozenset({"user", "username", "account"})
_DETERMINER_BEFORE_RE = re.compile(r"\b(?:the|this|that|these|those|a|an|its|their|our|his|her|my|your)\s+$", re.I)


def _target_after(question: str, kind_at: int, at: int, token: str) -> tuple[int, str] | None:
    """The name a kind word introduces, as ``(offset, value)``, or ``None``. After an
    explicit kind word ("user", "account", "host", "machine", …) the next word is the
    name the analyst typed ("lock user dsingh", "isolate host workstation"), whatever
    its shape, unless it is a word that never names one: "lock the user OUT", "contain
    the host NOW", "the host of THE attacker". A linking word ("the account of dsingh")
    is passed over, and so is a second kind word that only describes ("the user
    account dsingh", "the host machine dc01"); "host workstation" with no article names
    a host called workstation."""
    described = bool(_DETERMINER_BEFORE_RE.search(question[:kind_at]))
    for _hop in range(3):
        value = token.strip(".,;:")
        low = value.lower()
        if low in _TARGET_LINK or (low in _DEEP_KINDS and (described or low in _USER_KIND_WORDS)):
            following = _NEXT_TOKEN_RE.match(question, at + len(token))
            if following is None:
                return None
            at, token = following.start(1), following.group(1)
            continue
        if low in _TARGET_STOP or low in _TARGET_NOT_NAME or low in _DEEP_STOP or low in _LOG_TERM_GENERIC:
            return None
        return at, value
    return None


def _response_targets(question: str) -> list[tuple[str, str]]:
    """``(kind, value)`` of each host, user and indicator a response action names, in
    the analyst's own words ("isolate host srv-db-01 and block IP 203.0.113.77"), at
    most three, so the answer can offer to investigate them instead."""
    found: list[tuple[int, str, str]] = []
    spans: list[tuple[int, int]] = []
    for kind, pattern in (("ip", _IPV4_RE), ("hash", _HASH_RE), ("domain", _DOMAIN_RE)):
        # An email's local part ("j.smith" of "j.smith@corp.example") is not a domain.
        found.extend((m.start(), kind, m.group(0)) for m in pattern.finditer(question)
                     if not question.startswith("@", m.end()))
    for match in _DEEP_ENTITY_RE.finditer(question):
        kind = _DEEP_KINDS.get(match.group(1).lower(), "host")
        if kind == "ip":
            continue
        named = _target_after(question, match.start(1), match.start(2), match.group(2))
        if named is None:
            continue
        at, value = named
        if _IPV4_RE.fullmatch(value) or _DOMAIN_RE.fullmatch(value):
            continue
        found.append((at, kind, value))
        spans.append((at, at + len(value)))
    # An indicator inside a named host or user ("corp.example" of user
    # "j.smith@corp.example") is that name, offered once and whole.
    found = [f for f in found if f[1] in ("host", "user")
             or not any(start <= f[0] and f[0] + len(f[2]) <= end for start, end in spans)]
    out: list[tuple[str, str]] = []
    for _at, kind, value in sorted(found):
        if (kind, value) not in out and not any(value == v for _k, v in out):
            out.append((kind, value))
    return out[:3]


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


#: An investigation of what one named thing did (polish round PB5): "investigate user
#: pnair", "look into host dc01", "the activity of user pnair", "pnair's activity",
#: "what did user pnair do yesterday". Such a question is about that entity, never
#: about whichever case happens to be newest.
_INVESTIGATION_CUE_RE = re.compile(
    r"\binvestigat\w*\b|\b(?:look|looking|dig|digging|delve|delving) into\b|"
    r"\b(?:activit(?:y|ies)|behaviou?rs?|actions?|movements?)\s+(?:of|for|by|from)\b|"
    r"'s\s+(?:recent\s+)?(?:activit(?:y|ies)|behaviou?rs?|actions?|movements?)\b|"
    r"\bwhat (?:did|has|have|had|was|is|were)\b.{1,80}?\b(?:do|done|doing|been up to|up to)\b")
#: An email address ("jdoe@corp.example", "j.smith@corp.example"), whole.
_EMAIL_RE = re.compile(r"(?<![\w.%+@-])[A-Za-z0-9][A-Za-z0-9._%+-]{0,63}@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}"
                       r"[A-Za-z0-9])?\.)+[A-Za-z]{2,24}\b")
#: "domain bad.example", "hash 44d8…": a kind word for an indicator kind.
_INDICATOR_KIND_WORD_RE = re.compile(
    r"\b(?:domain(?: name)?|(?:file )?hash|sha-?256|sha-?1|md5|url)\s+[\"'`]?(\S+?)[\"'`]?(?=[\s,;:?!]|\.?$)",
    re.IGNORECASE)
#: An untyped actor named by its activity: "pnair's activity", "the activity of pnair",
#: "what did pnair do", or the object of the verb itself: "investigate pnair".
_ACTOR = r"[\"'`]?([A-Za-z0-9][A-Za-z0-9._@\\-]{1,62}?)[\"'`]?"
#: A full stop ends a name only where the sentence ends ("investigate dc01."): inside
#: a name it is part of it ("admin@corp.example", "T1059.001", "j.smith"), so the lazy
#: name match never stops at its first dot (polish round PB6).
_NAME_END_DOT = r"\.(?=\s|$)"
_UNTYPED_SUBJECT_RES: tuple[re.Pattern[str], ...] = (
    re.compile(rf"(?<![\w.@\\-]){_ACTOR}'s\s+(?:recent\s+)?(?:activit|behaviou?r|action|movement|event|log|"
               r"log-?in|log-?on|sign-?in|session|traffic)", re.IGNORECASE),
    re.compile(rf"\b(?:activit(?:y|ies)|behaviou?rs?|actions?|movements?)\s+(?:of|for|by|from)\s+(?:the\s+)?"
               rf"{_ACTOR}(?=$|[\s?!,;:]|{_NAME_END_DOT})", re.IGNORECASE),
    re.compile(rf"\bwhat\s+(?:did|has|have|had|was|is)\s+{_ACTOR}\s+(?:do|done|doing|been doing|been up to|up to)\b",
               re.IGNORECASE),
    re.compile(rf"^\s*(?:please\s+)?(?:(?:can|could|would) you\s+)?(?:investigate|look into|dig into|delve into)\s+"
               rf"{_ACTOR}(?=\s*$|\s*[?!,;:]|\s*{_NAME_END_DOT}|\s+(?:in|over|during|since|from|for|today|tonight|"
               r"yesterday|this|last|and|between|on|before|after|until)\b)", re.IGNORECASE),
)
#: Words that never name an actor of an investigation: pronouns, quantities, time
#: words, the people of the console and the record nouns a case question names.
_SUBJECT_NOT_NAME = frozenset({
    "everything", "anything", "something", "nothing", "everyone", "anyone", "someone", "nobody", "everybody",
    "further", "more", "deeper", "closely", "carefully", "manually", "now", "today", "tonight", "yesterday",
    "overnight", "again", "first", "next", "later", "agent", "agents", "analyst", "analysts", "people", "admin",
    "admins", "ai", "llm", "model", "models", "team", "soc", "system", "systems", "network", "console", "chat",
    "i", "escalation", "escalations", "ticket", "tickets", "investigation", "investigations", "detection",
    "detections", "spike", "spikes", "anomaly", "anomalies", "outage", "outages", "queue", "backlog",
    "week", "month", "day", "days", "hour", "hours", "morning", "evening", "night", "weekend",
})


#: Words another rule of the planner reads (polish round PB6): an ATT&CK id (the
#: technique plan), cost and spend (the cost plan), sources and ingestion (source
#: health), tuning, approvals and autopilot (automation status), and the product,
#: measure and breakdown words a Help Center or metric answer is about. "Investigate
#: T1059.001", "What did spend do this week?" or "What is ingestion doing?" asks about
#: that, never for a log hunt of the word.
_PRODUCT_WORD_RE = re.compile(
    r"t\d{4}(?:\.\d{3})?|costs?|spend|spent|spending|tokens?|budgets?|billing|money|pric(?:e|es|ing)|"
    r"silent|sources?|ingest\w*|connectors?|feeds?|coverage|poll(?:s|er|ers|ing)?|"
    r"approvals?|proposals?|tun(?:e|er|ers|ing)|thresholds?|baselines?|schedulers?|telemetry|autopilot|"
    r"automations?|auto-?clos\w*|risk|risks|enrich\w*|reputation|sla|slas|mtt[adr]|severity|severities|"
    r"priority|priorities|verdicts?|posture|kpis?|metrics?|runbooks?|playbooks?|reports?|dashboards?|audit")


def _actor_word(value: str) -> bool:
    low = value.lower().strip(".,;:")
    return bool(low) and not (
        low in _SUBJECT_NOT_NAME or low in _TARGET_STOP or low in _TARGET_NOT_NAME or low in _DEEP_STOP
        or low in _LOG_TERM_GENERIC or low in _DEEP_KINDS or low.isdigit() or _keyword(low) is not None
        or _metric(low) is not None or _CASE_ID_RE.fullmatch(low) is not None
        or _PRODUCT_WORD_RE.fullmatch(low) is not None)


def _investigated(question: str, lowered: str) -> tuple[str, str] | None:
    """``(kind, value)`` of the entity an investigation names (polish round PB5), or
    None. The first one named wins: a host or user after its kind word ("user pnair",
    "the host srv-db-01"), an email address as a user (PB6), an IP, URL, hash or domain
    by its shape or after its kind word, else a name of no stated kind ("pnair's
    activity", "investigate pnair"), whose kind is ``keyword``, unless another rule
    reads that word (an ATT&CK id, cost, sources, tuning: :data:`_PRODUCT_WORD_RE`). A
    question with no investigation cue, or a failed sign-in question (the brute-force
    plan reads those), names none here."""
    if not _INVESTIGATION_CUE_RE.search(lowered) or _BRUTE_RE.search(lowered):
        return None
    found: list[tuple[int, str, str]] = []
    spans: list[tuple[int, int]] = []
    for match in _DEEP_ENTITY_RE.finditer(question):
        kind = _DEEP_KINDS.get(match.group(1).lower(), "host")
        if kind == "ip":
            continue  # an address is read by its shape below
        named = _target_after(question, match.start(1), match.start(2), match.group(2))
        if named is None:
            continue
        at, value = named
        if value.lower().endswith("'s"):
            value = value[:-2]
        found.append((at, kind, value))
        spans.append((at, at + len(value)))
    for match in _EMAIL_RE.finditer(question):
        # An email address names a user (polish round PB6), never its domain:
        # "jdoe@corp.example" is jdoe's activity, not corp.example's. One after "user"
        # is that user already.
        at = match.start()
        if not any(start <= at < end for start, end in spans):
            found.append((at, "user", match.group(0)))
            spans.append((at, match.end()))
    indicator = _indicator(question, lowered)
    if indicator is None:
        for match in _INDICATOR_KIND_WORD_RE.finditer(question):
            shaped = _indicator(match.group(1), "check " + match.group(1).lower())
            if shaped is not None:
                indicator = shaped
                break
    if indicator is not None:
        value, kind = indicator
        at = question.lower().find(value.lower())
        at = at if at >= 0 else len(question)
        if not any(start <= at < end for start, end in spans):
            found.append((at, kind, value))
    if found:
        _at, kind, value = min(found)
        return kind, value
    for pattern in _UNTYPED_SUBJECT_RES:
        match = pattern.search(question)
        if match is not None and _actor_word(match.group(1)):
            return "keyword", match.group(1).strip(".,;:")
    return None


#: "Investigate …" (or "look into …") at the start of a question, and what it asks to
#: investigate.
_INVESTIGATE_LEAD_RE = re.compile(r"^\s*(?:please\s+)?(?:(?:can|could|would) you\s+)?(?:investigate|look into|dig "
                                  r"into|delve into)\s+(?P<rest>\S.*)$", re.IGNORECASE | re.DOTALL)
#: An investigation that picks a case as the case plan does: by recency or status ("the
#: newest escalated case", "the escalations"). A reference back to what the conversation
#: is about ("it", "this", "further") picks one too (:data:`_BACK_REFERENCE_RE`); "the
#: riskiest case" or "the top 5 cases" is a list, planned as "Show …" plans it.
_PICKS_A_CASE_RE = re.compile(
    r"\b(?:newest|latest|most recent|last)\b[^.?!]{0,40}\b(?:cases?|incidents?)\b|\bescalat\w*\b")
_BACK_REFERENCE_RE = re.compile(r"^(?:it|this|that|these|those|them|further|more|deeper|again|everything|anything)\b"
                                r"(?!\s+(?:rule|source)\b)")
#: "rule LP-ES-RISK-1001", "the noisy rule demo_impossible_travel", "detection rule
#: `web_portal_auth`": a detection rule an investigation names by its id.
_NAMED_RULE_RE = re.compile(
    r"\b(?P<detection>detection\s+)?rule\s+(?:id\s+|named\s+|called\s+)?(?P<quote>[\"'`])?"
    r"(?P<id>[A-Za-z0-9_][\w.:/@#+$\\-]{0,255}?)[\"'`]?(?=[\s,;:?!]|\.?$)", re.IGNORECASE)
#: "source wazuh-prod", "the log source named Wazuh": a log source an investigation names.
_NAMED_SOURCE_RE = re.compile(
    r"\b(?:log\s+)?source\s+(?:named\s+|called\s+)?[\"'`]?(?P<name>[A-Za-z0-9][\w.:/@\\-]{0,119}?)[\"'`]?"
    r"(?=[\s,;:?!]|\.?$)", re.IGNORECASE)
#: Words after "source" that describe it rather than name it.
_SOURCE_NOT_NAME = frozenset({"health", "status", "state", "events", "event", "logs", "log", "data", "type", "types",
                              "named", "called", "list", "ips", "addresses"})


def _named_rule(question: str) -> str | None:
    """The detection rule an investigation names: an identifier with a digit, "_",
    "-", ".", ":" or "/" in it, a quoted one, or any one after "detection rule" (as
    :func:`_case_rule` reads it). "Rule versions" or "the rule that fired" name none."""
    for match in _NAMED_RULE_RE.finditer(question):
        value = match.group("id").rstrip(".")
        low = value.lower()
        if not value or low in _DEEP_STOP or low in _TARGET_NOT_NAME or low in _TARGET_STOP or low in _LOG_TERM_GENERIC:
            continue
        if match.group("detection") or match.group("quote") or re.search(r"[\d_.:/@#+$\\-]", value):
            return value
    return None


def _named_log_source(question: str) -> str | None:
    """The log source an investigation names after the word "source" ("source wazuh-prod"),
    or None ("the source that went quiet", "source IP 10.0.0.5")."""
    for match in _NAMED_SOURCE_RE.finditer(question):
        value = match.group("name").rstrip(".")
        if value and value.lower() not in _SOURCE_NOT_NAME and _actor_word(value):
            return value
    return None


#: What a rewritten investigation must not become: an answer that names nothing the
#: question asked about.
_UNMAPPED_INTENTS = frozenset({"fallback", "help", "unsupported", "clarify", "out_of_scope", "change", "respond",
                               "empty", "case"})


#: Trend subjects: what a "trend" or "over time" question is about.
_TREND_SUBJECTS: tuple[tuple[str, str], ...] = (
    (r"\bmtt[adr]\b|\bmean time\b|\bresponse times?\b|\btime to (?:acknowledge|resolve|detect|respond)\b|"
     r"\bdwell\b|\bresolution time\b|\back(?:nowledg\w*)? time\b", "timing"),
    # The automation rate is its own measure (closed by the AI agent ÷ closed), never
    # the false/true-positive rates.
    (r"\bautomation(?: rate)?\b|\bauto[- ]?clos\w* rate\b", "automation"),
    (r"\bfalse[- ]positive rate\b|\bfp rate\b|\bfalse positives?\b|\btrue[- ]positive rate\b|\btp rate\b|"
     r"\bfp\b", "rates"),
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
    ("compare", "this month vs last month"): "Compare this month with last month",
    ("compare", "this week vs last week"): "Compare this week with last week",
    ("compare", "this quarter vs last quarter"): "Compare this quarter with last quarter",
    ("compare", "this month vs the same month last year"): "Compare this month with the same month last year",
    ("count", "open cases"): "How many cases are open right now?",
    ("count", "cases this week"): "How many cases did we get this week?",
    ("count", "alerts in the last 24 hours"): "How many alerts did we get in the last 24 hours?",
    ("count", "ai spend today"): "What did the AI spend today?",
    ("breakdown", "cases by month"): "Break down cases by month",
    ("breakdown", "cases by severity"): "Break down cases by severity",
    ("breakdown", "alerts by host"): "Which hosts generated the most alerts in the last 7 days?",
    ("breakdown", "ai spend by model"): "AI spend by model for the last 30 days",
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


def _window_text(question: str, low: str, *, case_scoped: bool = False) -> str:
    """``low`` with the values the question searches for or names as an entity masked
    ("host jan-laptop", "logs for SEP", "user dec01"), for reading its window."""
    values: list[str] = []
    searched = _log_search(question, case_scoped=case_scoped)
    if searched is not None:
        values.extend(value for _key, value in searched[1])
    for found in _DEEP_ENTITY_RE.finditer(question):
        value = found.group(2).strip(".,;:")
        if value.lower() not in _DEEP_STOP and value.lower() not in _LOG_TERM_GENERIC:
            values.append(value)
    text = low
    for value in sorted({v.lower() for v in values if v}, key=len, reverse=True):
        text = re.sub(rf"(?<![\w.-]){re.escape(value)}(?![\w-]|\.\w)", " \u2063 ", text)
    return text


def _two_periods(low: str) -> tuple[Win, Win] | None:
    """``(window, other)`` for "Q3 vs Q2", "September vs August", "2026-09 vs 2026-08":
    the LATER period is the subject and the earlier one its baseline, whatever the
    order the analyst named them in ("Compare August and September" is September
    against August). "Between August and September" is one range, not a comparison."""
    if re.search(r"\bbetween\b", low):
        return None
    joins = r"\b(?:vs\.?|versus|compared? (?:to|with)|against|and)\b"
    if re.search(r"\bcompar\w*\b", low):
        joins = r"\b(?:vs\.?|versus|compared? (?:to|with)|against|and|to|with)\b"
    if not re.search(joins, low):
        return None
    parts = re.split(joins, low, maxsplit=1)
    if len(parts) != 2:
        return None
    first, second = _window_from(parts[0]), _window_from(parts[1])
    if first is None or second is None or first.unit is None or first.unit != second.unit:
        return None
    if first.unit not in ("day", "week", "month", "quarter", "year"):
        return None
    return _later_first(first, second)


#: Each "this" calendar token and the one just before it ("Compare yesterday and
#: today" is today against the day before, so like for like over the same elapsed time).
_PREVIOUS_TOKEN = {"today": "yesterday", "this_week": "last_week", "this_month": "last_month",
                   "this_quarter": "last_quarter", "this_year": "last_year", "ytd": "last_year"}


def _period_key(win: Win | None) -> tuple[int, int] | None:
    """``(year, first month)`` of a dated month, quarter or year window."""
    spec = win.spec if win is not None else None
    match = re.fullmatch(r"(\d{4})(?:-(\d{2})|-Q([1-4]))?", spec) if isinstance(spec, str) else None
    if match is None:
        return None
    month = int(match.group(2)) if match.group(2) else (int(match.group(3)) - 1) * 3 + 1 if match.group(3) else 1
    return int(match.group(1)), month


def _later_first(first: Win, second: Win) -> tuple[Win, Win]:
    """Two compared periods with the later one first (both dated, or a calendar token
    and the one before it; else as named)."""
    if _PREVIOUS_TOKEN.get(second.spec) == first.spec if isinstance(second.spec, str) else False:
        return second, first
    a, b = _period_key(first), _period_key(second)
    return (second, first) if a is not None and b is not None and a < b else (first, second)


#: A case-store subject ("cases", "incidents", "tickets") for breakdowns and counts.
_CASE_SUBJECT_RE = re.compile(r"\b(cases?|incidents?|tickets?|investigations?|escalations?)\b")
_COUNT_CUE_RE = re.compile(
    r"\b(how many|number of|count|total|amount of|volume|stats|statistics|breakdown|break(?:ing)? down|split|"
    r"distribution|segregat\w*|group(?:ed)? by|per|each|every|tally)\b")
#: The counting cues without "each" and "every": in a request for records they name
#: the records to list or explain ("every open case from the last 24 hours", "… this
#: week and explain each"), not a count spread over something.
_REAL_COUNT_CUE_RE = re.compile(
    r"\b(how many|number of|count|total|amount of|volume|stats|statistics|breakdown|break(?:ing)? down|split|"
    r"distribution|segregat\w*|group(?:ed)? by|per|tally)\b")


def _investigated_rule(q: str, low: str, ask: Callable[..., Ask]) -> Ask | None:
    """"Investigate rule LP-ES-RISK-1001" (polish round PB6): that rule's cases by
    verdict, or None when the investigation names no detection rule or picks a case.
    Read before the planner's word rules, because a rule id carries words of its own
    ("cost" in LP-COST-7, "risk" in LP-ES-RISK-1001) that ask for nothing."""
    if _INVESTIGATE_LEAD_RE.match(q) is None or _PICKS_A_CASE_RE.search(low):
        return None
    rule = _named_rule(q)
    if rule is None:
        return None
    # The id is a value, never words of the question (the plan reads ``lowered``).
    return ask("breakdown", group="verdict", rule=rule, lowered=low.replace(rule.lower(), "the rule"))


def _investigation_subject(q: str, low: str, view: PromptView, ask: Callable[..., Ask]) -> Ask | None:
    """The plan for "Investigate …" when it names something other than a case (polish
    round PB6), or None to investigate a case (the newest with the status it names,
    escalated by default). A case is picked only when the question picks one (by
    recency or status, "the escalations") or points back at what the
    conversation is about ("investigate it", "investigate further"). Otherwise a named
    detection rule gets its cases by verdict, a named log source its health and newest
    events, an attack type the keyword hunt, and anything else the plan the same words
    get as a request to show them ("the false positives from yesterday", "today's
    alerts"). Only what none of those read still starts from the newest escalated case
    (the answer names it as that)."""
    lead = _INVESTIGATE_LEAD_RE.match(q)
    if lead is None or _PICKS_A_CASE_RE.search(low):
        return None
    rest = lead.group("rest").strip()
    if _BACK_REFERENCE_RE.match(rest.lower()):
        return None
    named = _investigated_rule(q, low, ask)
    if named is not None:
        return named
    source = _named_log_source(q)
    if source is not None:
        return ask("source_events", starter_slots=(("source", display_text(source, 120)),))
    found = _keyword(low)
    if found is not None:
        return ask("pivot", keyword=found[0], topic=found[1])
    shown = classify(f"Show {rest}", view)
    return None if shown.intent in _UNMAPPED_INTENTS else shown


def classify(question: str, view: PromptView | None = None) -> Ask:
    """The intent of ``question`` (deterministic regex rules; order matters)."""
    view = view or PromptView()
    q = _resolve_clarified((question or "").strip(), view)
    low = q.lower()
    # Windows are read with the searched values and entity names masked, so a host
    # "jan-laptop" or a search for "SEP" never becomes a month.
    wlow = _window_text(q, low, case_scoped=view.case_scoped)
    compare: Any = _compare_from(wlow)
    compare_win: Win | None = None
    if compare is not None:
        win: Win | None = _compare_window(wlow)
    else:
        two = _two_periods(wlow)
        win = _window_from(wlow)
        if two is not None:
            win, compare_win = two
            compare = "explicit"
            if isinstance(win.spec, str) and _PREVIOUS_TOKEN.get(win.spec) == compare_win.spec:
                # "Yesterday and today", "last week and this week": the period just
                # before, compared like for like over the same elapsed time.
                compare, compare_win = "previous_period", None
    hours = win.hours if win is not None else None
    unread = _unread_window(wlow) if win is None else None
    template, headings = _report_request(low, q)
    # A report request is saved to Reports (SPEC D11) unless it is a question ABOUT
    # reports ("how do I export a report?") or a shift brief that names no report.
    save = bool(template) and not re.search(
        r"^\s*(?:how|where|what|why|when|which|can i|is there|are there|do we|does|did)\b", low) and (
        template != "shift" or bool(re.search(r"\breports?\b", low)))
    base: dict[str, Any] = {"question": q, "lowered": low, "hours": hours, "topic": _help_topic(q),
                            "report": template, "headings": headings, "win": win, "compare": compare,
                            "compare_win": compare_win, "bucket": _bucket_from(low), "group": _case_group_from(low),
                            "save": save, "unread": unread,
                            "mine": not view.case_scoped and bool(_MY_CASES_RE.search(low))}

    def ask(intent: str, **extra: Any) -> Ask:
        fields = dict(base)
        fields.update(extra)
        if intent not in _ANCHOR_INTENTS:
            # Only a lookup that sends a window needs a period dated: a product question
            # that mentions "September" runs no anchor lookup (SPEC D9).
            for key in ("win", "compare_win"):
                held = fields.get(key)
                if isinstance(held, Win) and held.pending is not None:
                    fields[key] = None
            if fields.get("win") is None:
                fields["hours"] = None
        return Ask(intent=intent, **fields)

    if not q:
        return ask("empty")
    if view.starter is not None:
        # Round 13: a console starter is planned from its template and slots (the
        # referenced value is data, never read from the question words).
        planned = _starter_ask(view, ask)
        if planned is not None:
            return planned
    step = _step_ask(q)
    if step is not None:
        # A step inspector follow-up is about one step of an earlier answer: the quoted
        # question inside it never sets a window, a report or a comparison of its own.
        return ask(f"{step.verb}_step", step=step, win=None, hours=None, compare=None, compare_win=None,
                   report=None, headings=(), bucket=None, group=None, save=False, unread=None)
    # Round 13 (T4): a follow-up chip is planned for what it names in the answer it
    # sits under; a few chips are planned in the words the planner already plans.
    chip = _chip_ask(view, q, low, ask)
    if chip is not None:
        return chip
    rewritten = _chip_rewrite(low)
    if rewritten and rewritten.lower() != low:
        return classify(rewritten, view)
    # Round 12 WP-ASK: an "Ask AI" chip's server-worded question about ONE value
    # (``agents.chat_entity``) is planned for its kind, never sending the value out.
    console = None if view.case_scoped else parse_entity_question(q)
    if console is not None:
        return _console_entity_ask(ask, *console)
    remember = _REMEMBER_RE.match(q)
    if remember and not re.search(r"\?\s*$", q):
        return ask("remember", memory=display_text(remember.group(1).strip(), 500))
    # Final review L4: a response action, or a request chat is not for at all (code,
    # a joke), gets an honest answer about what chat can do, never a case list or an
    # unrelated Help Center passage.
    shaped = _step_shaped_label(q)
    if _is_response_action(q, low) or (shaped is not None and _is_response_action(shaped, shaped.lower())):
        return ask("respond", save=False)
    acting = _acting(low)
    if (acting is not None and acting.group("verb") in _CONSOLE_VERBS
            and _CONSOLE_OBJECT_RE.search(_first_clause(acting.group("rest")))):
        # "Kill the export job", "Lock the case": a change to a console object.
        return ask("change", save=False)
    if _out_of_scope(low):
        return ask("out_of_scope", save=False)
    if _is_change(low) or _step_shaped_change(q):
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
    if view.prior_calls and (win is not None or _drop_keys(low)) and (
            re.search(r"\b(same|again|repeat|redo)\b", low)
            or re.match(r"^\s*(?:and\s+|now\s+)?(?:what|how) about\b", low)):
        return ask("rerun")
    clarify = None if view.case_scoped else _clarify_kind(low, view)
    if clarify:
        return ask("clarify", clarify=clarify, save=False)

    case_id = _case_id(q)
    if case_id:
        if template == "investigation_brief" or re.search(r"\bbrief\b|\bhandoff note\b", low):
            return ask("brief", case_id=case_id, report="investigation_brief",
                       save=not view.case_scoped and (save or bool(re.search(r"\bbrief\b", low))))
        return ask("case", case_id=case_id)
    if view.case_scoped and template == "investigation_brief":
        return ask("brief", save=False)
    if template == "investigation_brief" and not re.match(
            r"^\s*(?:how|where|what|why|when|which|can i|is there|are there|do we|does|did)\b", low):
        # "An investigation brief for the newest escalated case": the case is found
        # first (newest with the status named, escalated by default), then briefed.
        return ask("brief", case_status=_case_status(low) or "escalated", report="investigation_brief")
    if (base["mine"] and win is None and compare is None and not template and not _HELP_RE.search(low)
            and not _MINE_ELSEWHERE_RE.search(low) and _metric(low) is None and _plain_mine(ask("cases"))):
        # "Which of my open cases should I work on first?", "cases assigned to me": the
        # signed-in analyst's own open cases (assignee "me", Round 13 polish). A
        # question that names more ("my closed cases", "my critical cases", "my cases
        # by severity", "my cases this week") is classified as usual, and every case
        # lookup its plan sends carries assignee "me" (``Ask.mine``).
        return ask("my_cases")
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
            # No window named: the plan defaults to the last 30 days (the chip wins).
            return ask("deep", entity=entity)
    named_rule = None if view.case_scoped else _investigated_rule(q, low, ask)
    if named_rule is not None:
        return named_rule
    investigated = None if view.case_scoped else _investigated(q, low)
    if investigated is not None:
        # An investigation that names an entity is about that entity (polish round
        # PB5): a host or user gets the in-depth look (logs, its cases, decisions,
        # ATT&CK), an indicator or a name of no stated kind the hunt (reputation where
        # the kind has one, its log events, the cases that carry it). A case is chosen
        # only when the question names one (the rules above).
        kind, value = investigated
        if kind in ("host", "user"):
            return ask("deep", entity=(kind, value))
        return ask("hunt", indicator=(value, kind))
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
    # A request for records ("show the top 10 open cases by risk and explain each",
    # "list false positives this week") is a data request: a bare "explain" or "what
    # are" in it never makes it a definition, and a verdict noun in it names the
    # cases to list, not the false-positive rate.
    records = _asks_for_records(low)
    if records and metric and metric[1] == "false-positive rate" and _VERDICT_RECORDS_RE.search(low) and not (
            re.search(r"\b(?:rates?|fp rate)\b", low)):
        metric = None

    def compare_ask() -> Ask:
        # Period comparisons (SPEC P0-6), each over its own subject.
        subject = _trend_subject(low)
        if subject == "cost":
            return ask("cost")
        if subject == "alerts" and not _CASE_SUBJECT_RE.search(low):
            return ask("top", field=_group_field(low) or "rule")
        return ask("compare", subject=subject)

    def trend_ask() -> Ask:
        # Trends over time (SPEC P0-5): of what the question names, else a clarify.
        subject = _trend_subject(low)
        if subject is None:
            return ask("clarify", clarify="trend", save=False)
        if subject == "cost":
            return ask("cost", bucket=base["bucket"] or _natural_bucket(win or _relative(30, "d")))
        return ask("trend", subject=subject)

    # Counts of true or false positives are exact case counts, not a rate (a named
    # comparison is computed by the count itself).
    if not help_like and re.search(r"\b(?:how many|number of|count(?: of)?|total)\b", low) and re.search(
            r"\b(?:true|false)[- ]positives\b", low) and not re.search(r"\brates?\b", low):
        return ask("breakdown")
    # "What percentage of cases were auto closed?": the share, from exact case counts
    # (closed by the AI agent beside closed by an analyst), never a plain case list.
    # A share of the cost or budget stays a cost question; a share per period is the
    # automation-rate trend; a share WITHIN the AI's closes ("what % of auto-closed
    # cases were false positives") groups the closed cases by that part.
    if (not help_like and not template and _SHARE_CUE_RE.search(low) and _AUTO_CLOSE_RE.search(low)
            and not _COST_WORD_RE.search(low)):
        within = _within_auto_closed(low)
        if within is not None:
            return ask("breakdown", group=within[0] or "verdict")
        if _TREND_RE.search(low) or base["bucket"] or re.search(r"\b(?:each|every|per)\s+(?:day|week|month|"
                                                                r"quarter|year)\b", low):
            return ask("trend", subject="automation")
        return ask("breakdown")
    # "What's the FP rate trend?", "Is MTTR improving?": a trend or a comparison of a
    # named measure, never its definition (that needs a defining word).
    defining = bool(re.search(r"\b(?:mean|means|meaning|definition|define[sd]?|calculat\w*|comput\w*)\b", low)) or (
        bool(re.search(r"\bexplain\w*\b", low)) and not records)
    if not help_like and not template and not defining:
        if compare is not None and (metric or _trend_subject(low)):
            return compare_ask()
        if _TREND_RE.search(low) and _trend_subject(low):
            return trend_ask()
    if metric and _defines(low, records):
        return ask("explain_metric", metric=metric[0], topic=metric[1])
    if help_like or (_ACCESS_RE.search(low) and not re.search(r"\b(cases?|logs?|alerts?)\b", low)):
        return ask("help", wants_access=bool(_ACCESS_RE.search(low)),
                   wants_overview=bool(_OVERVIEW_RE.search(low)), save=False)
    if compare is not None and not template:
        return compare_ask()
    # Performance, executive, monthly and infographic reports; a report request with no
    # other subject is one too ("Last 90 days or whatever reports you can").
    asks_about = bool(re.match(r"^\s*(?:how|where|what|why|when|which|is|are|do|does|can i)\b", low))
    if template in ("executive", "monthly", "infographic") and not asks_about or (
            template == "custom" and not asks_about and _PERFORMANCE_RE.search(low)
            and not re.search(r"\bsections?:|\b(?:hunt|ioc|indicator)\b", low)) or (
            template == "custom" and not asks_about and not _CASE_SUBJECT_RE.search(low) and not _keyword(low)
            and not re.search(r"\b(logs?|events?|hosts?|users?|ips?|rules?|cost|spend|noise|funnel|campaigns?|"
                              r"sources?|mitre|att&ck)\b", low)):
        chosen = template if template in ("executive", "monthly", "infographic") else "executive"
        if chosen == "monthly" and win is None:
            win = _token_win("last_month")
        return ask("perf_report", report=chosen, win=win, hours=win.hours if win else None)
    # Trends over time (SPEC P0-5): of what the question names, else a clarify.
    if not template and (_TREND_RE.search(low) or base["bucket"] and re.search(
            r"\b(mtt[adr]|response times?|fp rate|false[- ]positive rate|tp rate|automation rate|spend|cost)\b",
            low)):
        return trend_ask()
    if not help_like and not defining and re.search(r"\b(?:tp|true[- ]positive) rates?\b", low):
        # "What is our TP rate?", "True positive rate last month": the rate itself from
        # the exact case counts (the posture tiles carry no true-positive rate).
        return ask("rate")
    if metric and not help_like and (re.search(r"\b(?:our|ours|we)\b", low) or (
            re.search(r"\bmy\b", low) and not base["mine"]) or re.match(
            r"^\s*(?:please\s+)?(?:show|give|display|get|pull|list|plot|chart)\b", low)):
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
    if re.search(r"\bwhat did (?:the )?(?:agents?|analysts?|the ai|people|users?|admins?) do\b|"
                 r"\bwho (?:did|changed|closed) what\b", low):
        return ask("audit")
    if re.search(r"\bsla\b|\bservice[- ]level\b", low) and not help_like:
        return ask("posture")
    if re.search(r"\b(cost|costs|spend|spent|spending|tokens?|budget|billing|money)\b|\$", low):
        return ask("cost")
    if _BRUTE_RE.search(low):
        return ask("brute")
    if re.search(r"\bhunt\w*\b|\bpivot\b", low):
        found = _keyword(low)
        return ask("pivot", keyword=found[0] if found else None, topic=found[1] if found else "")
    if re.search(r"\binvestigat\w*\b|\b(newest|latest|most recent)\b.*\bcase\b|\bwhy (?:was|is|did)\b.*\bcase\b",
                 low):
        named = None if view.case_scoped else _investigation_subject(q, low, view, ask)
        if named is not None:
            return named
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
    entity_cases = _ENTITY_CASES_RE.search(low)
    if entity_cases and not help_like:
        word = (entity_cases.group(1) or entity_cases.group(2) or "user").split()[0].rstrip("s")
        return ask("entity_cases", field=_ENTITY_KIND.get(word, "user"))
    # Exact counts and breakdowns over every case (SPEC D8, case_stats).
    # "Weekly breakdown of false positives": verdict nouns are a case subject too.
    case_subject = bool(_CASE_SUBJECT_RE.search(low)) or bool(
        re.search(r"\b(?:true|false)[- ]positives\b", low) and (base["bucket"] or base["group"]))
    # A windowed request for records ("show the top 10 open cases this week by risk and
    # explain each", "list each critical case this week") lists them: only a real
    # counting cue (how many, number of, breakdown, per, group by) makes it a count.
    count_cue = (_REAL_COUNT_CUE_RE if records else _COUNT_CUE_RE).search(low)
    if case_subject and (base["bucket"] or base["group"] or (count_cue and win is not None)
                         or re.search(r"\b(?:case|incident) (?:stats|statistics|numbers|counts?|volume|breakdown)\b",
                                      low)):
        return ask("breakdown")
    # "What happened in the last 2 weeks?", "Give me the Q3 numbers", "Stats for March
    # 2026": a summary of the period (case volume and mix, posture, true positives).
    if win is not None and win.spec != "today" and (
            re.search(r"\bwhat (?:happened|went on|did we see|has happened)\b", low)
            or re.search(r"\b(?:stats|statistics|numbers|figures)\b", low) and not case_subject
            # "Summarize the last 24 hours", "Give me a summary of last month".
            or re.search(r"\b(?:summar(?:y|ies|ise|ize|ised|ized)|recap|sum up|rundown|round-?up)\b", low)
            and not case_subject and not re.search(r"\b(?:true|false)[- ]positives?\b", low)):
        return ask("summary")
    # "How many alerts did we get today?": an event count by severity, not a case count.
    if not case_subject and re.search(r"\b(?:how many|number of|count(?: of)?|total|volume of)\b", low) and re.search(
            r"\b(?:alerts?|events?|detections?)\b", low):
        return ask("top", field=_group_field(low) or "severity")
    if re.search(r"\b(true positives?|confirmed (?:incidents?|threats?)|what happened today|"
                 r"today'?s (?:cases|incidents|activity)|summari[sz]e (?:today|the day))\b", low):
        return ask("tp")
    if _UNSUPPORTED_RE.search(low) and _LIST_CUE_RE.search(low) and not re.search(r"\b(logs?|events?|cases?)\b", low):
        return ask("unsupported", save=False)
    log_field = _group_field(low)
    if log_field and re.search(r"\b(events?|alerts?|logs?|log volume|activit(?:y|ies))\b", low) and not (
            _CASE_SUBJECT_RE.search(low)):
        # "Events by severity this week", "activity by severity": a log count by that field.
        return ask("top", field=log_field)
    if re.search(r"\b(top|most|noisiest|busiest|loudest|which)\b", low) and re.search(
            r"\b(hosts?|machines?|servers?|endpoints?|users?|accounts?|ips?|ip addresses|rules?)\b", low):
        fld = next((f for words, f in _GROUP_FIELDS if re.search(rf"\b{words}\b", low)), "host")
        return ask("top", field=fld)
    if re.search(r"\bmost alerts\b|\bnoisiest\b", low):
        return ask("top", field="host")
    if re.search(r"\b(posture|how (?:are|is|'re) (?:we|things|the soc|our)|overview|risk index|"
                 r"state of|kpis?|metrics|how are we doing|performance|"
                 r"how (?:did|have|has|were) (?:we|things|the soc|our team)(?: been)? (?:do|doing|done|perform\w*|go|"
                 r"going|gone|fare|fared))\b", low):
        return ask("posture")
    if re.search(r"\b(?:fp|tp|false[- ]positive|true[- ]positive|automation|auto[- ]?close) rates?\b", low):
        return ask("posture")
    if _defines(low, records) or low.startswith(("what", "how", "where", "why")) and not re.search(
            r"\b(cases?|alerts?|incidents?|logs?|events?)\b", low):
        return ask("help", wants_access=bool(_ACCESS_RE.search(low)),
                   wants_overview=bool(_OVERVIEW_RE.search(low)), save=False)
    if re.search(r"\b(cases?|incidents?|alerts?)\b", low) or records and _VERDICT_RECORDS_RE.search(low):
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
    if tool not in _LOG_WINDOW_TOOLS and isinstance(win.spec, str) and re.fullmatch(r"now-\d+m", win.spec):
        # Case, metric and cost lookups count whole hours (they refuse a minute
        # window): the next whole hour, said in the answer (:func:`_minutes_note`).
        win = _relative(win.hours or 1, "h")
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


def _needs_clock(ask: Ask) -> bool:
    """The question names a clock time on a day ("since 14:10 today"): the clock
    anchor (today's one-day bucket), not the monthly anchor, dates it."""
    return any(w is not None and w.pending is not None and w.pending[0] == "clock" for w in (ask.win, ask.compare_win))


def _resolved(view: PromptView, ask: Ask) -> Ask:
    """``ask`` with a period named without its year dated from the anchor (unchanged
    when nothing waits for it). Two compared periods keep the later one as the
    subject. When the anchor did not answer, the named period is dropped, each
    lookup's own default applies, and ``undated`` names it so the answer says so."""
    if not _needs_anchor(ask):
        return ask
    if _needs_clock(ask):
        today = _clock_today(view)
        win, other = _clocked(ask.win, today), _clocked(ask.compare_win, today)
        undated = None if today is not None else _join(
            [w.phrase for w in (ask.win, ask.compare_win) if w is not None and w.pending is not None])
        return replace(ask, win=win, compare_win=other, hours=win.hours if win is not None else None,
                       anchored=today is not None, undated=undated or None)
    anchor = _anchor(view)
    win, other = _anchored(ask.win, anchor), _anchored(ask.compare_win, anchor)
    compare = ask.compare if other is not None or ask.compare != "explicit" else None
    if compare == "explicit" and win is not None and other is not None:
        win, other = _later_first(win, other)
    undated = None
    if anchor is None:
        undated = _join([w.phrase for w in (ask.win, ask.compare_win) if w is not None and w.pending is not None])
    return replace(ask, win=win, compare_win=other, hours=win.hours if win is not None else None,
                   compare=compare, anchored=anchor is not None, undated=undated or None)


def _is_anchor_call(result: Result) -> bool:
    """The anchor lookup's own shape (a 12-month breakdown by month, nothing else)."""
    inp = result.input
    if not inp:
        return result.tool in ("case_stats", "soc_metrics", "cost_usage")
    return (inp.get("window") == _ANCHOR_WINDOW and inp.get("bucket") == "month"
            and set(inp) <= {"window", "bucket", "kind"})


def _without_anchor(view: PromptView, ask: Ask) -> PromptView:
    """The view a final reads: without the anchor round when this ask was dated by one
    (the anchor is planner context, never the answer's data: its 12 months must not be
    narrated as "September" or as an entity's cases)."""
    if not _needs_anchor(ask) or not view.rounds:
        return view
    first = view.rounds[0]
    if len(first) != 1 or not (_is_anchor_call(first[0]) or _is_clock(first[0])):
        return view
    return replace(view, rounds=view.rounds[1:])


def _anchored_plan(planner: Callable[[PromptView, Ask, int], list[Call]]) -> Callable[[PromptView, Ask, int], list[Call]]:
    """``planner`` preceded, when the question names a month or quarter without its
    year, by the anchor lookup that supplies the year."""
    def plan(view: PromptView, ask: Ask, done: int) -> list[Call]:
        if not _needs_anchor(ask):
            return planner(view, ask, done)
        if _needs_clock(ask):
            anchor = Call("case_stats", dict(_CLOCK_INPUT)) if view.can("case_stats") else None
        else:
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
    if lookup_kind and not ask.no_lookup:
        calls.append(Call("lookup_indicator", {"indicator": value, "kind": lookup_kind}))
    log_filter = {"ip": {"ip": value}, "host": {"host": value}, "user": {"user": value}}.get(
        kind, {"contains": value})
    calls.append(Call("search_logs", {**log_filter, **_log_window(ask, view, default)}))
    calls.append(Call("search_cases", {"entity": value, "limit": 10}))
    return calls


def _case_read_ref(case: Mapping[str, Any]) -> str:
    """How a planned case read names a case a lookup listed: its display number when
    it has one (``get_case`` and ``explain_decision`` resolve numbers, and the run log
    then shows the number the analyst knows), else its id (:func:`_case_handle`)."""
    return _case_handle(case) or str(case.get("case_id") or "")


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
            calls = [Call("get_case", dict(case_input)), Call("explain_decision", dict(case_input))]
            if ask.starter == "my_cases_one" and view.can("search_cases"):
                # "What should I do next on my case?": the caller's own open cases beside
                # it (assignee "me", Round 13 polish), so the answer can say where it stands.
                calls.append(Call("search_cases", dict(_MY_OPEN_CASES)))
            return calls
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
        case_id = _case_read_ref(case)
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
        return [Call("get_case", {"case_id": _case_read_ref(case)})] if case else []
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
    "log_stats": ("ip", "user", "host", "rule", "contains", "source_id", "severity_gte", "group_by"),
    "search_logs": ("ip", "user", "host", "rule", "contains", "source_id", "severity_gte"),
    "search_cases": ("text", "status", "status_group", "verdict", "entity", "severity", "assignee", "rule",
                     "sort_field", "limit"),
    "case_stats": ("text", "status", "status_group", "verdict", "entity", "severity", "assignee", "rule", "group_by",
                   "bucket", "metrics", "top_n"),
    "soc_metrics": ("kind", "bucket"),
    "cost_usage": ("bucket",),
    "shift_report": (),
    "audit_search": ("actor", "action_type", "surface"),
}
_LIST_ARGS = frozenset({"group_by", "metrics", "ids", "include"})
_INT_ARGS = frozenset({"top_n", "window_hours", "limit"})
_WITHOUT_FILTER_RE = re.compile(r"\bwithout the ([a-z][a-z ]{1,30}?) filter\b")
#: A zero-result chip's display words back to the input keys it drops (Round 13 B
#: note): the chips name a field as the analyst reads it ("Without the source IP
#: filter", "Open and closed cases", "Any severity"), never the raw key, so the rerun
#: maps the words back ("source IP" is ``ip``; "text" is ``text`` on cases and
#: ``contains`` on logs).
_DROP_WORD_KEYS: dict[str, tuple[str, ...]] = {
    "source ip": ("ip",), "ip": ("ip",), "source ip address": ("ip",), "text": ("text", "contains"),
    "keyword": ("text", "contains"), "user": ("user",), "host": ("host",), "rule": ("rule",),
    "assignee": ("assignee",), "entity": ("entity",), "verdict": ("verdict",),
    "severity": ("severity", "severity_gte"), "priority": ("priority",), "status": ("status",),
    "open or closed": ("status_group",), "open and closed": ("status_group",), "status group": ("status_group",),
    "source": ("source_id",),
}
_DROP_PHRASES: tuple[tuple[re.Pattern[str], tuple[str, ...]], ...] = (
    (re.compile(r"\bfor (?:the )?open and closed cases\b|\bincluding closed cases\b"), ("status_group",)),
    (re.compile(r"\bfor any severity\b"), ("severity", "severity_gte")),
    (re.compile(r"\bacross all sources\b"), ("source_id",)),
)


def _drop_keys(low: str) -> tuple[str, ...]:
    """The input keys a widening follow-up drops ("…without the source IP filter" →
    ``ip``, "…for open and closed cases" → ``status_group``); empty when it names none."""
    drop = _WITHOUT_FILTER_RE.search(low)
    if drop:
        words = drop.group(1).strip()
        return _DROP_WORD_KEYS.get(words, (words.replace(" ", "_"),))
    return next((keys for pattern, keys in _DROP_PHRASES if pattern.search(low)), ())


def _plan_rerun(view: PromptView, ask: Ask, done: int) -> list[Call]:
    """The latest answer's lookups again, with the window the question names ("same
    for all time") or without one filter ("…without the text filter"): the engine's
    zero-result suggestions as one-click follow-ups."""
    drop_keys = _drop_keys(ask.lowered)
    if done or (ask.win is None and not drop_keys and ask.compare is None):
        return []
    latest = view.prior_calls[-1].key if view.prior_calls else None
    # A comparison re-runs only the lookups that compare periods (the log or cost
    # figures the chip sits under), never a case list beside them.
    compared = ("log_stats", "cost_usage") if ask.compare is not None else None
    return [Call(prior.tool, _rerun_input(prior, ask, view, drop_keys)) for prior in view.prior_calls
            if prior.key == latest and prior.tool in _RERUN_KEYS and (compared is None or prior.tool in compared)]


def _rerun_input(prior: PriorCall, ask: Ask, view: PromptView,
                 drop_keys: Sequence[str] | str | None = None) -> dict[str, Any]:
    """An earlier lookup's input rebuilt from its digest: the same filters, then the
    window the question names (``ask.win``), else the lookup's own window."""
    dropped = {drop_keys} if isinstance(drop_keys, str) else set(drop_keys or ())
    inp: dict[str, Any] = {}
    for key in _RERUN_KEYS.get(prior.tool, ()):
        value = prior.arg(key)
        if not value or key in dropped:
            continue
        if key in _LIST_ARGS:
            inp[key] = [v for v in value.split(",") if v]
        elif key in _INT_ARGS:
            number = _safe_float(value)
            if number is not None:
                inp[key] = int(number)
        elif key == "severity_gte":
            number = _safe_float(value)
            if number is not None:
                inp[key] = number
        else:
            inp[key] = value
    if prior.tool == "search_cases" and inp.get("status_group") == "active" and inp.get("sort_field") == "created_at":
        # This planner lists open cases by creation time only oldest first (age and
        # backlog questions); the lookup digest does not carry the sort order.
        inp["sort_order"] = "asc"
    if ask.compare is not None and ask.intent == "rerun" and prior.tool in ("log_stats", "cost_usage"):
        # "Compare this with the previous 24 hours" under a log or cost answer: the
        # same lookup over the same window, with the period before it.
        inp["compare"] = _compare_spec(ask)
    elif (ask.intent == "rerun" and ask.compare is None and prior.arg("compare") in _KEPT_COMPARES
          and not (ask.win is not None and ask.win.all_time)):
        # "Show the same for the last 30 days" under a comparison (SPEC §4.1: offered
        # only when a comparison ran): the same comparison over the window named.
        inp["compare"] = prior.arg("compare")
    if ask.win is not None and not (ask.compare is not None and ask.intent == "rerun"):
        inp.update(_win_args(prior.tool, ask, view))
    else:
        for key in ("window", "time_from", "time_to", "window_hours"):
            value = prior.arg(key)
            if key == "window" and value and value.startswith("{"):
                # A range window ({"from": …, "to": …}) as the digest wrote it (JSON).
                ranged = _json_window(value)
                if ranged is not None:
                    inp[key] = ranged
            elif value and not value.startswith(("{", "[")):
                inp[key] = int(value) if key == "window_hours" and value.isdigit() else value
    return inp


#: The comparisons a rerun keeps (a named other period is not carried to a new window).
_KEPT_COMPARES = ("previous_period", "same_period_last_year")


def _json_window(value: str) -> dict[str, str] | None:
    """A digest's range window back to its ``{"from", "to"}`` form, else None."""
    try:
        parsed = json.loads(value)
    except ValueError:
        return None
    if not isinstance(parsed, dict) or not parsed or set(parsed) - {"from", "to"}:
        return None
    if not all(isinstance(v, str) and len(v) <= 40 for v in parsed.values()):
        return None
    return {k: parsed[k] for k in ("from", "to") if k in parsed}


# --------------------------------------------------------------------------- #
# Step inspector follow-ups (WP-GEN-A): "Explain step N (…) of your answer to “…”"
# and "Run step N (…) of your answer to “…” again …" name ONE step of an earlier
# answer. The planner finds that answer by its quoted question and the step among its
# lookups by the step's template label, then explains it from the conversation (no
# lookup) or re-runs exactly that lookup with its own inputs.
# --------------------------------------------------------------------------- #
#: Model steps of the run log (``agents/chat.py`` labels): they read no data.
_MODEL_STEP_PURPOSES: dict[str, str] = {
    "thinking": "the model reading the question and deciding what to look up",
    "planned lookups": "the model choosing which lookups to run next",
    "writing the answer": "the model writing the answer from the lookups that had run",
    "wrote the answer": "the model writing the answer from the lookups that had run",
    "reply format corrected": "the engine asking the model to resend a reply it could not read",
    "model call failed": "a model call that failed",
    "stopped": "where the answer was stopped",
    "summarised earlier messages": "the model summarising earlier messages so the conversation fits its context",
    "wrapped up after a very long investigation": ("the model writing the answer from what the lookups had "
                                                   "gathered, once the investigation had run very long"),
}
_CONTINUED_STEP_RE = re.compile(r"^continued the answer \(part \d{1,3}\)$")
#: Each chat tool's input model (module under ``agents/chat_tools``, class name): a
#: step rerun reads the step's inputs back from the digest's display text into the
#: types that model accepts ("10" → 10, "host" → ["host"], a window object).
_TOOL_INPUT_MODELS: dict[str, tuple[str, str]] = {
    "search_cases": ("cases", "SearchCasesInput"), "get_case": ("cases", "GetCaseInput"),
    "shift_report": ("cases", "ShiftReportInput"), "list_campaigns": ("cases", "ListCampaignsInput"),
    "explain_decision": ("cases", "ExplainDecisionInput"), "mitre_lookup": ("intel", "MitreLookupInput"),
    "search_knowledge": ("intel", "SearchKnowledgeInput"), "search_logs": ("logs", "SearchLogsInput"),
    "log_stats": ("logs", "LogStatsInput"), "soc_metrics": ("metrics", "SocMetricsInput"),
    "cost_usage": ("metrics", "CostUsageInput"), "source_health": ("ops", "SourceHealthInput"),
    "automation_status": ("ops", "AutomationStatusInput"), "audit_search": ("ops", "AuditSearchInput"),
    "case_stats": ("stats", "CaseStatsInput"), "app_help": ("app_help", "AppHelpInput"),
    "app_status": ("app_status", "AppStatusInput"),
}
#: Lookups a step rerun never repeats, and why (the answer says so in plain words).
#: An indicator lookup is re-run like any other: the engine's taint rule decides
#: whether its value may be sent out (a value the analyst typed may; any other value
#: is refused visibly), exactly as it would for a model.
_NO_STEP_RERUN: dict[str, str] = {
    "recall_observation": ("it re-read another lookup's result inside that answer, so there is nothing to repeat "
                           "on its own"),
}
_FAILED_OUTCOME_RE = re.compile(r"^(?:error|denied|timeout|skipped|cancelled)\b")
#: A digest value the display bound cut ("…") or that carries a visible escape of a
#: hidden character: it no longer reads back as the value the lookup was sent.
_UNREADABLE_ARG_RE = re.compile(r"\u2026$|\\u[0-9a-fA-F]{4}")


def _model_step_purpose(label: str) -> str | None:
    low = label.strip().lower()
    if _CONTINUED_STEP_RE.match(low):
        return "the model continuing an answer that had reached its output length"
    return _MODEL_STEP_PURPOSES.get(low)


def _is_step_label(label: str) -> bool:
    """``label`` is one the run log writes: a model step's, a chat tool's template
    label or the recall step's. Free text in the label position is not a step."""
    return _model_step_purpose(label) is not None or bool(_tools_for_label(label))


def _tools_for_label(label: str) -> tuple[str, ...]:
    """The chat tools whose run-log label is ``label`` (the registry's own labels)."""
    try:
        from ..agents.chat_tools import recall as recall_tool
        from ..agents.chat_tools.registry import catalogue
    except Exception:  # noqa: BLE001 -- advisory: an unknown label explains generically
        return ()
    low = label.strip().lower()
    names = [t.name for t in catalogue() if str(getattr(t, "label", "")).strip().lower() == low]
    if recall_tool.LABEL.lower() == low:
        names.append(recall_tool.NAME)
    return tuple(names)


def _quote_key(text: str) -> str:
    """A question as the console quotes it (display-normalised, one line, 120 chars)."""
    return re.sub(r"\s+", " ", display_text(text or "", 120)).strip().casefold()


def _step_answer(view: PromptView, step: StepRef) -> tuple[str, str] | None:
    """``(key, question)`` of the earlier answer the step belongs to, or None."""
    answers = view.prior_answers
    if not answers:
        return None
    if not step.quote:
        return answers[-1]
    want = _quote_key(step.quote)
    matches = [a for a in answers if a[1] and _quote_key(a[1]) == want]
    if not matches and want.endswith(("\u2026", "...")):
        # The console cut a long question: its quote is a prefix.
        prefix = want.rstrip(".\u2026").rstrip()
        matches = [a for a in answers if a[1] and _quote_key(a[1]).startswith(prefix)]
    rank = step.recency or 1
    return matches[-rank] if 0 < rank <= len(matches) else None


@dataclass(frozen=True)
class StepMatch:
    """The lookup a step follow-up names (``call``), all lookups of its answer, and
    whether several lookups could be that step (``ambiguous``: never guessed)."""

    call: PriorCall | None
    calls: tuple[PriorCall, ...] = ()
    ambiguous: bool = False


def _step_call(view: PromptView, step: StepRef, key: str) -> StepMatch:
    """The lookup step ``step.index`` of answer ``key`` was. The digest numbers each
    lookup with its run-log step (``step 8 log_stats(…)``), so the number names it
    exactly, also when the answer ran several rounds of the same tool; the label must
    name that lookup's tool (an unknown label never matches). A digest without
    numbers (an older record) is matched by label and position (a step's lookup sits
    at position ``index - 1`` or earlier): when more than one lookup with that label
    fits, the step is ambiguous and nothing is guessed."""
    calls = tuple(c for c in view.prior_calls if c.key == key)
    tools = _tools_for_label(step.label)
    if any(c.step is not None for c in calls):
        exact = [c for c in calls if c.step == step.index]
        if len(exact) > 1:
            # Two lookups claim one step number (a value that imitates the digest):
            # the step cannot be told apart, so it is not guessed.
            return StepMatch(None, calls, ambiguous=True)
        if exact and exact[0].tool in tools:
            return StepMatch(exact[0], calls)
        return StepMatch(None, calls)
    fits = [c for position, c in enumerate(calls, start=1) if c.tool in tools and position <= step.index - 1]
    if len(fits) == 1:
        return StepMatch(fits[0], calls)
    return StepMatch(None, calls, ambiguous=len(fits) > 1)


def _tool_input_model(tool: str) -> Any:
    """The pydantic input model of chat tool ``tool``, or None (lazy import)."""
    spec = _TOOL_INPUT_MODELS.get(tool)
    if spec is None:
        return None
    try:
        import importlib

        module = importlib.import_module(f"..agents.chat_tools.{spec[0]}", __package__)
    except Exception:  # noqa: BLE001 -- advisory: the generic conversions follow
        return None
    model = getattr(module, spec[1], None)
    return model if hasattr(model, "model_validate") and hasattr(model, "model_fields") else None


def _digest_arg_candidates(name: str, raw: str) -> list[Any]:
    """The values a digest's display text can stand for, typed first (a flag, a
    number, the planner's list inputs as lists), then the text itself, then a list:
    the input model keeps the first one it accepts. An object or list written as text
    is parsed, and is unreadable when that fails."""
    text = raw.strip()
    if text.startswith(("{", "[")):
        for parse in (json.loads, _literal):
            try:
                value = parse(text)
            except Exception:  # noqa: BLE001 -- not that notation
                continue
            if isinstance(value, (dict, list)):
                return [value]
        return []
    parts = [v.strip() for v in text.split(",") if v.strip()]
    out: list[Any] = []
    if text.lower() in ("true", "false"):
        out.append(text.lower() == "true")
    number = _safe_float(text)
    if number is not None:
        out.append(int(number) if number.is_integer() else number)
    if name in _LIST_ARGS:
        out.append(parts)
    out.append(text)
    if name not in _LIST_ARGS:
        out.append(parts)
    return out


def _literal(text: str) -> Any:
    import ast

    return ast.literal_eval(text)


def _step_rerun_input(prior: PriorCall) -> tuple[dict[str, Any], list[str]]:
    """A step's own inputs read back from the digest (every one, not a filter subset)
    in the types its tool accepts, plus the names of inputs that could not be read
    back (cut by the display bound, an unparseable object, an input the tool does not
    take): the rerun says it ran without them rather than "with the same inputs"."""
    model = _tool_input_model(prior.tool)
    fields = getattr(model, "model_fields", None) or {}
    options: dict[str, list[Any]] = {}
    dropped: list[str] = []
    for name, raw in prior.args:
        if not raw or name in options:
            continue
        candidates = [] if _UNREADABLE_ARG_RE.search(raw) else _digest_arg_candidates(name, raw)
        if model is not None and name not in fields:
            candidates = []
        if model is None and candidates:
            # No model to check against: the planner's own typed arguments.
            if name in _INT_ARGS:
                candidates = [c for c in candidates if isinstance(c, int) and not isinstance(c, bool)][:1]
            elif name not in _LIST_ARGS:
                candidates = [c for c in candidates if isinstance(c, str)][:1] or candidates[:1]
            else:
                candidates = candidates[:1]
        if candidates:
            options[name] = candidates
        else:
            dropped.append(name)
    chosen = {name: 0 for name in options}
    if model is not None:
        from pydantic import ValidationError

        for _attempt in range(sum(len(c) for c in options.values()) + 1):
            try:
                model.model_validate({n: options[n][i] for n, i in chosen.items()})
                break
            except ValidationError as exc:
                failing = {err["loc"][0] for err in exc.errors() if err.get("loc") and err["loc"][0] in chosen}
            except Exception:  # noqa: BLE001 -- an input model that cannot judge: send as read
                break
            if not failing:
                break  # a cross-field rule: the tool refuses it visibly when it runs
            for name in failing:
                chosen[name] += 1
                if chosen[name] >= len(options[name]):
                    del chosen[name]
                    dropped.append(name)
    inp = {n: options[n][i] for n, i in chosen.items()}
    if (prior.tool == "search_cases" and inp.get("status_group") == "active" and inp.get("sort_field") == "created_at"
            and "sort_order" not in inp):
        # This planner lists open cases by creation time only oldest first (age and
        # backlog questions); the lookup digest does not carry the sort order.
        inp["sort_order"] = "asc"
    return inp, list(dict.fromkeys(dropped))


def _plan_rerun_step(view: PromptView, ask: Ask, done: int) -> list[Call]:
    step = ask.step
    if done or step is None:
        return []
    answer = _step_answer(view, step)
    prior = _step_call(view, step, answer[0]).call if answer is not None else None
    if prior is None or prior.tool in _NO_STEP_RERUN:
        return []
    inp, _dropped = _step_rerun_input(prior)
    if not view.can(prior.tool, inp.get("kind")):
        # Not granted any more: the answer says so (never the degraded fallback).
        return []
    return [Call(prior.tool, inp)]


def _plan_simple(build: Callable[[PromptView, Ask], list[Call]]) -> Callable[[PromptView, Ask, int], list[Call]]:
    def plan(view: PromptView, ask: Ask, done: int) -> list[Call]:
        return build(view, ask) if done == 0 else []
    return plan


#: ``log_stats`` interval for a calendar unit.
_INTERVALS = {"hour": "1h", "day": "1d", "week": "1w", "month": "1M", "quarter": "1q", "year": "1y"}


_OPEN_WORDS_RE = re.compile(r"\b(open|active|unresolved|still open|not (?:yet )?closed|outstanding|backlog|pending)\b")
_CLOSED_WORDS_RE = re.compile(r"\b(closed|resolved|terminal)\b|\bdid (?:we|you|they|the team|analysts?) (?:close|resolve)\b")
_SPECIFIC_STATUSES = frozenset({"escalated", "on_hold", "investigating", "new"})
_NOT_AN_ENTITY = frozenset({"we", "you", "they", "i", "the", "our", "analyst", "analysts", "it", "he", "she", "team",
                            "soc", "people", "anyone", "everyone", "agents", "agent", "ai"})


def _case_entity(question: str) -> str | None:
    """The host, user or IP the cases are about ("cases for user pnair", "cases
    involving host dc01", "how many cases did pnair have"), else None."""
    match = _IPV4_RE.search(question)
    if match:
        return match.group(0)
    for found in re.finditer(r"\b(?:host(?:name)?|user(?:name)?|ip)\s+[\"'`]?([A-Za-z0-9][A-Za-z0-9._@\\-]{1,62})",
                             question, re.IGNORECASE):
        value = found.group(1).strip(".,;:")
        if value.lower() not in _DEEP_STOP and value.lower() not in _LOG_TERM_GENERIC:
            return value
    match = re.search(r"\bhow many (?:cases|incidents) (?:did|does|has|have) ([A-Za-z][\w.@-]{1,40}) "
                      r"(?:have|had|get|got|see|generate|trigger)\b", question, re.IGNORECASE)
    if match and match.group(1).lower() not in _NOT_AN_ENTITY:
        return match.group(1)
    return None


def _status_filters(ask: Ask) -> dict[str, Any]:
    """``status`` (escalated, on hold, investigating, new) or ``status_group`` (open or
    closed) the question names. A question ABOUT open and closed ("open vs closed")
    filters neither: it groups by them."""
    low = ask.lowered
    status = _case_status(low)
    if ask.group not in ("status", "status_group") and status in _SPECIFIC_STATUSES:
        return {"status": status}
    if ask.group in ("status", "status_group"):
        return {}
    opened, closed = _OPEN_WORDS_RE.search(low), _CLOSED_WORDS_RE.search(low) or _AUTO_CLOSE_RE.search(low)
    if opened and closed:
        return {}
    if opened:
        return {"status_group": "active"}
    if closed:
        return {"status_group": "terminal"}
    return {}


def _case_filters_for(ask: Ask) -> dict[str, Any]:
    """The case filters the question names (status, status group, severity, verdict,
    entity, text)."""
    low = ask.lowered
    inp: dict[str, Any] = dict(_status_filters(ask))
    entity = _case_entity(ask.question)
    if entity:
        inp["entity"] = entity
    if ask.group != "severity":
        severity = next((s for s in ("critical", "high", "medium", "low") if re.search(rf"\b{s}\b", low)), None)
        if severity:
            inp["severity"] = severity
    if ask.group != "verdict" and not _volume_and_verdict(low):
        verdict = next((v for p, v in ((r"needs?[- ]human", "NEEDS_HUMAN"), (r"false[- ]positives?", "FALSE_POSITIVE"),
                                       (r"true[- ]positives?", "TRUE_POSITIVE")) if re.search(p, low)), None)
        if verdict and not re.search(r"\b(?:fp|tp|false[- ]positive|true[- ]positive) rate\b", low):
            inp["verdict"] = verdict
    if re.search(r"\bunassigned\b", low):
        inp["assignee"] = "unassigned"
    if ask.mine:
        # "My cases": the signed-in analyst's own (resolved on the server).
        inp["assignee"] = _ASSIGNEE_ME
    # Round 12 WP-ASK: "cases from detection rule X" filters on that rule; a keyword
    # read out of the rule's own name ("brute" in demo_rdp_bruteforce) is not a filter.
    rule = ask.rule or _case_rule(ask.question)
    if rule:
        inp["rule"] = rule
    found = _keyword(low)
    if found and not (rule and found[0].lower() in rule.lower()):
        inp["text"] = found[0]
    return inp


_VOLUME_AND_VERDICT_RE = re.compile(
    r"\b(?:(?:case )?volume|(?:number|count) of cases|all cases|cases)\b[^.?!]{0,40}\b(?:and|with|plus|including)\b"
    r"[^.?!]{0,20}\b(?:false|true)[- ]positives?\b"
    r"|\b(?:false|true)[- ]positives?\b[^.?!]{0,20}\b(?:and|with|plus)\b[^.?!]{0,20}\b(?:case )?volume\b")


def _volume_and_verdict(low: str) -> bool:
    """"Case volume and false positives": the cases AND the share of one verdict among
    them (Round 13 T37). The verdict is a figure to report, not a filter on the
    cases, so the counts cover every case and the breakdown is by verdict."""
    return bool(_VOLUME_AND_VERDICT_RE.search(low))


def _case_metrics_for(ask: Ask) -> list[str]:
    low = ask.lowered
    metrics = ["count"]
    if _volume_and_verdict(low):
        metrics.append("tp_rate" if re.search(r"\btrue[- ]positives?\b", low)
                       and not re.search(r"\bfalse[- ]positives?\b", low) else "fp_rate")
    if _AUTO_CLOSE_RE.search(low):
        # "How many cases did the AI close?": closed automatically, beside the analysts' closes.
        metrics += ["auto_closed", "human_closed"]
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


def _case_groups(ask: Ask) -> list[str]:
    """The ``group_by`` fields a breakdown asks for: one, two named together ("by
    severity and assignee"), or "open vs closed" plus a second field ("open vs closed
    cases by severity"). With a creation-time bucket, one field."""
    named = [fld for pattern, fld in _CASE_GROUP_WORDS if re.search(pattern, ask.lowered)]
    if ask.group and "status_group" in named:
        other = next((fld for fld in named if fld != "status_group"), None)
        return ["status_group", other] if other else ["status_group"]
    groups = list(dict.fromkeys([g for g in (ask.group, *_named_groups(ask.lowered)) if g]))
    return groups[:1] if ask.bucket else groups[:2]


def _plan_breakdown(view: PromptView, ask: Ask, done: int) -> list[Call]:
    """Exact counts over every case (``case_stats``), grouped and bucketed as asked
    (and compared with another period when the question asks). Open cases broken
    down by when they were opened, or by age, also list the oldest of them."""
    if done:
        return []
    filters = _case_filters_for(ask)
    inp: dict[str, Any] = dict(filters)
    groups = _case_groups(ask)
    stats_only = not groups and not ask.bucket
    compare = _compare_spec(ask)
    if groups:
        inp["group_by"] = groups
        if set(groups) & {"rule", "assignee", "source", "closed_by", "mitre_technique", "mitre_tactic"}:
            inp["top_n"] = _top_n(ask.lowered)
    elif stats_only and compare is None:
        # A count of one verdict ("how many false positives") splits by severity
        # instead: a verdict split of one verdict says nothing.
        inp["group_by"] = [next((f for f in ("verdict", "severity", "status") if f not in filters), "status")]
    if ask.bucket:
        inp["bucket"] = ask.bucket
    metrics = _case_metrics_for(ask)
    if stats_only and re.search(r"\b(stats|statistics|numbers|summary|overview)\b", ask.lowered):
        metrics = list(dict.fromkeys(metrics + ["fp_rate", "auto_closed", "human_closed", "open_now", "mttr_p50"]))[:6]
    volume_verdict = _volume_and_verdict(ask.lowered) and stats_only and compare is None
    rate = next((m for m in metrics if m in ("fp_rate", "tp_rate")), None)
    if volume_verdict:
        # T37: the verdict split is the share itself (its counts); a false-positive rate
        # per verdict would be 0% or 100%. The rate is shown per rule instead.
        metrics = [m for m in metrics if m not in ("fp_rate", "tp_rate")]
    if metrics != ["count"]:
        inp["metrics"] = metrics
    if compare is not None:
        inp["compare"] = compare
    window = _windowed(ask, view)
    inp.update(window)
    calls = [Call("case_stats", inp)]
    if volume_verdict and rate:
        calls.append(Call("case_stats", {**filters, "group_by": ["rule"], "metrics": ["count", rate], "top_n": 10,
                                         **window}))
    older = ask.win is not None and ask.win.older
    if filters.get("status_group") == "active" and (ask.bucket or older):
        # "When were they opened?" or "older than 14 days": the oldest cases still
        # open, beside the counts.
        calls.append(Call("search_cases", {**filters, "sort_field": "created_at", "sort_order": "asc", "limit": 5,
                                           **window}))
    elif stats_only and not filters and compare is None and not (ask.win and (ask.win.hours or 2) <= 1):
        # The volume over the same window, by its natural calendar unit (context).
        calls.append(Call("case_stats", {"bucket": _natural_bucket(ask.win) if ask.win else "month", **window}))
    return calls


def _plan_entity_cases(view: PromptView, ask: Ask, done: int) -> list[Call]:
    """Cases by the user, host or IP they involve. Cases are not grouped by entity, so
    the highest-risk cases name the candidates, then each candidate's cases are
    counted exactly (``case_stats`` filtered to that entity)."""
    filters = {**_status_filters(ask), **({"assignee": _ASSIGNEE_ME} if ask.mine else {})}
    window = _windowed(ask, view)
    if done == 0:
        return [Call("search_cases", {**filters, "sort_field": "risk_score", "limit": 50, **window})]
    if done == 1:
        found = view.ok("search_cases")
        kind = ask.field if ask.field in ("user", "host", "ip") else "user"
        values: list[str] = []
        for case in (found.obs.get("cases") if found else None) or []:
            entity = case.get("entity") if isinstance(case, Mapping) else None
            if isinstance(entity, str) and entity.lower().startswith(f"{kind}:"):
                value = entity.split(":", 1)[1].strip()
                if value and value.lower() not in {v.lower() for v in values}:
                    values.append(value[:128])
        return [Call("case_stats", {**filters, "entity": value, **window})
                for value in values[:max(1, min(4, view.max_parallel))]]
    return []


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
    if subject == "automation":
        # "Auto close percentage of critical cases per month": the cases the question
        # narrows to stay narrowed (named in the answer), never silently dropped.
        narrowed = {k: v for k, v in _case_filters_for(ask).items()
                    if k in ("severity", "verdict", "entity", "rule") or (k == "assignee" and ask.mine)}
        return [Call("case_stats", {**narrowed, "bucket": bucket, "metrics": ["count", "auto_closed", "human_closed"],
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
                                 "compare": compare, **window})]
    if not filters:
        # The posture tiles cover every case: beside a filtered comparison ("critical
        # cases this month vs last") they would read as the filtered figures.
        calls.append(Call("soc_metrics", {"kind": "posture", "compare": compare, **window}))
    calls.append(Call("case_stats", {**filters, "group_by": [_compare_group(ask, filters)], "compare": compare,
                                     **window}))
    if ask.subject == "timing" and not filters:
        calls.append(Call("soc_metrics", {"kind": "timing", "compare": compare, **window}))
    return calls


def _compare_group(ask: Ask, filters: Mapping[str, Any]) -> str:
    """The comparison's split: the grouping named, else severity, never a field the
    comparison is already filtered to (critical cases split by severity says nothing)."""
    held = {key for key in ("severity", "verdict", "status") if filters.get(key)}
    if filters.get("status_group"):
        held.add("status_group")
    group = ask.group or "severity"
    if group not in held:
        return group
    return next(f for f in ("verdict", "severity", "status", "assignee") if f not in held)


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
    techniques, then the indicator's reputation when the entity is one. Without a case
    id (outside a case conversation) the newest case with the status named is found
    first ("the newest escalated case")."""
    if not ask.case_id and not view.case_scoped:
        if done == 0:
            return [Call("search_cases", {"status": ask.case_status or "escalated", "sort_field": "created_at",
                                          "limit": 5})]
        case = _newest_case(view.ok("search_cases"))
        if case is None:
            return []
        return _plan_brief(view, replace(ask, case_id=case["case_id"]), done - 1)
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
        if kind == "ip" and not ask.no_lookup:
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
        # Only the campaigns that involve the entity (Round 13 close: the table listed
        # every campaign while the text named the one about it).
        calls = [Call("list_campaigns", {"entity": value, "limit": 10}), Call("source_health", {})]
        if case is not None:
            calls[:0] = [Call("get_case", {"case_id": _case_read_ref(case)}),
                         Call("explain_decision", {"case_id": _case_read_ref(case)})]
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


# --------------------------------------------------------------------------- #
# Round 13: console starters (SPEC-chat §3.4, §3.8, §3.14, §7.3). A starter is a
# server-worded question with typed slots. The planner reads its template and slots
# like a model that honours the fence: a referenced value is DATA (a lookup filter or
# a case id), never words it acts on, and it is not the analyst's own text, so no plan
# sends it to a third-party lookup (``no_lookup``; the engine would refuse it too).
# Counts in a starter are the console's reading when the chat page loaded: answers
# come from current lookups and say plainly when they differ.
# --------------------------------------------------------------------------- #
#: Starters the ordinary rules already answer as asked (no reference, nothing that
#: can go stale): they are classified like any question.
_CLASSIFIED_STARTERS = frozenset({"weekly", "monthly", "posture", "report", "explain_metric", "demo",
                                  "connect_source"})
#: Case Manager chips (value-free, about the turn's own case, SPEC §3.14) → intent.
_CASE_CHIP_INTENTS: dict[str, str] = {
    "case_needs_person": "case", "case_undecided": "case", "case_closed_why": "case",
    "case_entity": "case_entity", "case_related": "case_related", "case_handoff": "brief",
}
#: Starters whose intent follows from the template alone.
_STARTER_INTENTS: dict[str, str] = {
    "my_cases": "my_cases", "sla_breached": "sla", "sla_close": "sla", "new_cases": "new_since",
    "new_cases_one": "new_since", "volume_spike": "volume", "volume_drop": "volume", "noisy_rule": "noisy_rule",
    "noisy_rule_unnamed": "noisy_rule", "campaign": "campaign", "campaign_by_id": "campaign",
    "campaign_latest": "campaign", "silent_source": "source", "silent_source_unnamed": "source",
    "silent_sources": "source", "approvals": "approvals",
    "approvals_one": "approvals", "platform": "auto_close", "triage": "triage",
}
#: Starters about ONE case the console expected to be open: the answer says so plainly
#: when the case was closed after the suggestion was made (SPEC §3.8.7).
_OPEN_CASE_STARTERS = frozenset({"needs_human", "my_cases_one", "sla_breached_one", "sla_close_one"})
#: Starters that ask what something is or where to start: answered from the Help
#: Center's own words first, then where in the console to see it.
_ORIENTATION_STARTERS = frozenset({"demo", "learn_app", "explain_metric"})
#: The Help Center query of the "learn the app" starter.
_LEARN_APP_QUERY = "Getting started with the console"


def _starter_ask(view: PromptView, ask: Callable[..., Ask]) -> Ask | None:
    """The plan of a console starter (``view.starter``), or ``None`` to classify it like
    any question. The fenced value only ever lands in a typed field (a case id, a rule
    filter, a technique id, a source to find in a list)."""
    template_id, slots = view.starter or ("", {})
    if template_id in _CLASSIFIED_STARTERS or (template_id not in STARTER_TEMPLATES
                                                and template_id not in LEGACY_STARTER_TEMPLATES):
        return None
    fields: dict[str, Any] = {
        "starter": template_id, "starter_slots": tuple(sorted(slots.items())), "no_lookup": True,
        "win": None, "hours": None, "compare": None, "compare_win": None, "report": None, "headings": (),
        "bucket": None, "group": None, "save": False, "unread": None,
    }
    if template_id in _CASE_CHIP_INTENTS:
        if not view.case_scoped:
            return None  # a chip's words in a Workspace chat: an ordinary question
        intent = _CASE_CHIP_INTENTS[template_id]
        if intent == "brief":
            fields["report"] = "investigation_brief"
        return ask(intent, **fields)
    if template_id in ("needs_human", "my_cases_one"):
        return ask("case", case_id=slots.get("case"), **fields)
    if template_id in ("sla_breached_one", "sla_close_one"):
        return ask("sla_case", case_id=slots.get("case"), **fields)
    if template_id in ("shift_start", "shift_handoff"):
        hours = int(slots.get("h") or 24)
        return ask("shift", **{**fields, "report": "shift", "win": _relative(hours, "h"), "hours": hours})
    if template_id in ("budget_ai", "budget_chat"):
        today = _token_win("today")
        return ask("budget", **{**fields, "win": today, "hours": today.hours})
    if template_id == "hunt":
        return ask("technique_hunt", **{**fields, "techniques": (str(slots.get("technique") or ""),)})
    if template_id == "learn_app":
        return ask("help", **{**fields, "topic": _LEARN_APP_QUERY, "wants_access": True})
    intent = _STARTER_INTENTS.get(template_id)
    return ask(intent, **fields) if intent else None


def _plan_sla_case(view: PromptView, ask: Ask, done: int) -> list[Call]:
    """One case and the SLA view of the open queue (its age, owner, how overdue)."""
    if done:
        return []
    # No id in a Case Manager chat: the engine reads the chat's own case.
    return [Call("get_case", {"case_id": ask.case_id} if ask.case_id else {}),
            Call("shift_report", {"attention_limit": 25})]


#: The caller's own open cases by risk (assignee "me", which the lookup resolves to the
#: signed-in analyst).
_MY_OPEN_CASES: dict[str, Any] = {"status_group": "active", "assignee": "me", "sort_field": "risk_score",
                                  "limit": 10}


#: A "my cases" question about something other than the case list itself (a shift
#: brief, the posture, a trend, response targets): classified as usual.
_MINE_ELSEWHERE_RE = re.compile(
    r"\b(?:shift|handoff|hand-off|handover|hand over|stand-?up|posture|trends?|over time|sla|service[- ]level|"
    r"response targets?|campaigns?|noise|funnel)\b")


def _plain_mine(ask: Ask) -> bool:
    """A "my cases" question that names nothing but the analyst's open cases: no
    other status, no verdict, severity, entity, rule or text, no breakdown or bucket
    (the caller checks the window and comparison). It gets the fixed my-cases plan; any
    other "my" question is classified as usual with assignee "me" in its filters."""
    if ask.group or ask.bucket:
        return False
    named = {k: v for k, v in _case_filters_for(ask).items() if k != "assignee"}
    return named in ({}, {"status_group": "active"})


def _plan_my_cases(view: PromptView, ask: Ask, done: int) -> list[Call]:
    """The caller's own open cases by risk (assignee "me", which the lookup resolves to
    the signed-in analyst). With nobody signed in "me" matches no case, so the open
    queue by assignee follows instead."""
    if done == 0:
        return [Call("search_cases", dict(_MY_OPEN_CASES))]
    if done == 1 and _nobody_signed_in(view.ok("search_cases")) and view.can("case_stats"):
        return [Call("case_stats", {"status_group": "active", "group_by": ["assignee"]})]
    return []


def _nobody_signed_in(result: Result | None) -> bool:
    """Did a case lookup with assignee "me" find nobody signed in?"""
    return bool(result is not None and result.obs.get("assignee_me") == ASSIGNEE_ME_NOBODY)


def _is_my_search(result: Result) -> bool:
    """A case lookup for the caller's own cases (assignee "me")."""
    assignee = result.input.get("assignee") if isinstance(result.input, Mapping) else None
    return isinstance(assignee, str) and assignee.strip().lower() == "me"


def _plan_shift_queue(view: PromptView, ask: Ask, done: int) -> list[Call]:
    """The shift snapshot: SLA ageing, the attention queue and the workload; for the
    cases past their target, then the most overdue one itself (the snapshot names
    the overdue cases by id only)."""
    if done == 0:
        return [Call("shift_report", {"attention_limit": 25})]
    if done == 1 and ask.starter == "sla_breached" and view.can("get_case"):
        listed, _breached, _close, _complete = _sla_rows(view.ok("shift_report"))
        first = next(iter(listed), None)
        # The overdue row carries the case's number when it has one: the read names it.
        row = next((b for b in _dig(view.ok("shift_report").obs, "sla", "breached") or []
                    if isinstance(b, Mapping) and str(b.get("case_id")) == first), {})
        return [Call("get_case", {"case_id": _case_read_ref({**row, "case_id": first})})] if first else []
    return []


#: The clock anchor of a "since {time}" starter: today's date in the operator time zone,
#: from data (a one-day breakdown names it), never from a clock (the planner has none).
_CLOCK_INPUT: dict[str, Any] = {"window": "today", "bucket": "day"}
_DAY_LABEL_RE = re.compile(r"^(\d{1,2}) ([A-Z][a-z]{2}) (\d{4})$")
_SINCE_CLOCK_RE = re.compile(r"^(?:(yesterday|Mon|Tue|Wed|Thu|Fri|Sat|Sun) )?([01]\d|2[0-3]):([0-5]\d)$")
_SINCE_DAY_RE = re.compile(r"^([1-9]|[12]\d|3[01]) ([A-Z][a-z]{2})$")
_WEEKDAYS = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")


def _is_clock(result: Result) -> bool:
    return result.tool == "case_stats" and result.input == _CLOCK_INPUT


def _clock_today(view: PromptView) -> date | None:
    """Today in the operator time zone, from the clock anchor's one-day bucket."""
    for r in view.results():
        if not (r.ok and _is_clock(r)):
            continue
        for bucket in reversed([b for b in r.obs.get("buckets") or [] if isinstance(b, Mapping)]):
            match = _DAY_LABEL_RE.match(str(bucket.get("label") or ""))
            if match and match.group(2) in _MONTH_SHORT:
                try:
                    return date(int(match.group(3)), _MONTH_SHORT.index(match.group(2)) + 1, int(match.group(1)))
                except ValueError:
                    return None
    return None


def _since_start(label: Any, today: date | None) -> str | None:
    """The instant a ``{since}`` label names (``chat_starter_text.format_since``: "09:12"
    today, "yesterday 18:40", "Mon 18:40" within the last week, "12 Oct" before that)
    as a naive ISO timestamp in the operator time zone, or ``None``."""
    if not isinstance(label, str) or today is None:
        return None
    match = _SINCE_CLOCK_RE.match(label)
    if match:
        day_word, hour, minute = match.groups()
        if day_word is None:
            day = today
        elif day_word == "yesterday":
            day = today - timedelta(days=1)
        else:
            back = next((n for n in range(2, 7) if (today - timedelta(days=n)).weekday() == _WEEKDAYS.index(day_word)),
                        None)
            if back is None:
                return None
            day = today - timedelta(days=back)
        return f"{day.isoformat()}T{hour}:{minute}"
    match = _SINCE_DAY_RE.match(label)
    if match and match.group(2) in _MONTH_SHORT:
        month, number = _MONTH_SHORT.index(match.group(2)) + 1, int(match.group(1))
        for year in (today.year, today.year - 1):
            try:
                day = date(year, month, number)
            except ValueError:
                continue
            if day <= today:
                return f"{day.isoformat()}T00:00"
    return None


def _since_window(view: PromptView, ask: Ask) -> dict[str, Any] | str:
    """The window of a "since {time}" starter: from that instant, else (no clock
    anchor) the last 7 days, which the answer then names."""
    start = _since_start(ask.slot("since"), _clock_today(view))
    return {"from": start} if start else "now-7d"


def _plan_new_since(view: PromptView, ask: Ask, done: int) -> list[Call]:
    anchored = view.can("case_stats")
    if anchored and done == 0:
        return [Call("case_stats", dict(_CLOCK_INPUT))]
    if done != (1 if anchored else 0):
        return []
    window = _since_window(view, ask)
    calls = [Call("search_cases", {"window": window, "sort_field": "risk_score", "limit": 10})]
    if anchored:
        calls.append(Call("case_stats", {"window": window, "group_by": ["severity"]}))
    return calls


#: The total of the last 24 hours against the 24 hours before (one ungrouped count:
#: a case with several rules is counted once, never once per rule).
_VOLUME_TOTAL: dict[str, Any] = {"window": "now-24h", "compare": "previous_period"}
#: Hourly counts over the 8 days the card's "usual" covers: the seven 24-hour windows
#: that end at the start of the hour holding "24 hours ago" (``chat_starters``
#: ``volume_windows``), plus that hour, the last 24 hours and one leading partial hour.
_VOLUME_HOURLY: dict[str, Any] = {"window": "now-193h", "bucket": "hour"}


def _plan_volume(view: PromptView, ask: Ask, done: int) -> list[Call]:
    """New cases in the last 24 hours against the 24 hours before and against the
    usual daily level (the median of the seven days before, as the card counts it), by
    rule, and the last 7 days day by day."""
    if done:
        return []
    return [Call("case_stats", dict(_VOLUME_TOTAL)),
            Call("case_stats", {"window": "now-24h", "group_by": ["rule"], "top_n": 5,
                                "compare": "previous_period"}),
            Call("case_stats", dict(_VOLUME_HOURLY)),
            Call("case_stats", {"window": "now-7d", "bucket": "day"})]


def _volume_usual(view: PromptView) -> int | None:
    """The usual daily level the volume card names: the median of the seven 24-hour
    windows before the hour that holds "24 hours ago" (from one exact hourly count)."""
    hourly = view.ok("case_stats", where=lambda r: r.input == _VOLUME_HOURLY)
    if hourly is None or hourly.obs.get("exact") is False:
        return None
    labels = [str(b.get("label")) for b in hourly.obs.get("buckets") or [] if isinstance(b, Mapping)]
    counts: dict[str, float] = {}
    for g in _stats_groups(hourly.obs):
        if g.get("bucket") is not None:
            counts[str(g.get("bucket"))] = counts.get(str(g.get("bucket")), 0) + (_num(_dig(g, "metrics", "count")) or 0)
    if len(labels) < 24 * 8 + 1:
        return None
    hours = [counts.get(label, 0) for label in labels][-(24 * 8 + 1):-25]
    windows = sorted(sum(hours[i * 24:(i + 1) * 24]) for i in range(7))
    return int(windows[3])


#: The new cases of the last 24 hours by rule, the lookup a noisy-rule card without
#: its rule's id (``noisy_rule_unnamed``, polish round PB5) finds the rule with.
_NOISY_BY_RULE: dict[str, Any] = {"window": "now-24h", "group_by": ["rule"], "top_n": 10}


@dataclass(frozen=True)
class _RulePick:
    """The rule a noisy-rule card without its id is about (polish round PB5)."""

    rule: str
    count: float
    tied: tuple[str, ...]      # other rules with the same count (the answer says so)
    by_count: bool             # it created exactly the number of cases the card counted


def _noisy_rule_pick(view: PromptView, ask: Ask) -> _RulePick | None:
    """The rule a noisy-rule card that does not name its rule is about: the rule that
    created the number of cases the card counted (``n``), else, when the counts have
    moved, the rule that created the most now. Rules with the same count are kept as
    ``tied`` so the answer never presents one of them as the only one."""
    by_rule = view.ok("case_stats", where=lambda r: r.input == _NOISY_BY_RULE)
    groups = [(str(_dig(g, "key", "rule") or ""), _num(_dig(g, "metrics", "count")) or 0)
              for g in (_stats_groups(by_rule.obs) if by_rule else []) if g.get("bucket") is None]
    groups = [(rule, n) for rule, n in groups if rule]
    if not groups:
        return None
    said = _num(ask.slot("n"))
    matching = [(rule, n) for rule, n in groups if said is not None and n == said]
    pool = matching or [(rule, n) for rule, n in groups if n == max(c for _r, c in groups)]
    rule, count = pool[0]
    return _RulePick(rule=rule, count=count, tied=tuple(r for r, _n in pool[1:]), by_count=bool(matching))


def _plan_noisy_rule(view: PromptView, ask: Ask, done: int) -> list[Call]:
    named = ask.slot("rule") is not None
    if named and done:
        return []
    if not named and done == 0:
        # The card counted the rule without naming it: find it by its count first.
        return [Call("case_stats", dict(_NOISY_BY_RULE)), Call("case_stats", {"window": "now-24h"})]
    if not named and done > 1:
        return []
    pick = _noisy_rule_pick(view, ask) if not named else None
    if not named and pick is None:
        return []
    rule = str(ask.slot("rule") or "") if named or pick is None else pick.rule
    calls = [Call("case_stats", {"window": "now-24h", "rule": rule, "group_by": ["verdict"]}),
             Call("search_cases", {"window": "now-24h", "rule": rule, "sort_field": "risk_score", "limit": 5})]
    if named:
        calls.insert(1, Call("case_stats", {"window": "now-24h"}))
    return calls


def _campaign_row(view: PromptView, campaign_id: Any) -> Mapping[str, Any] | None:
    for r in view.results():
        if r.tool != "list_campaigns" or not r.ok:
            continue
        for row in r.obs.get("campaigns") or []:
            if isinstance(row, Mapping) and row.get("id") == campaign_id:
                return row
    return None


def _held_campaign(view: PromptView, case_ref: str) -> Result | None:
    """The listing of the campaigns that hold the starter's case."""
    return view.ok("list_campaigns", where=lambda r: r.input.get("case_id") == case_ref)


def _first_row(result: Result | None) -> Mapping[str, Any] | None:
    rows = [c for c in (result.obs.get("campaigns") if result else None) or [] if isinstance(c, Mapping)]
    return rows[0] if rows else None


def _plan_campaign(view: PromptView, ask: Ask, done: int) -> list[Call]:
    """The campaign itself, then the cases that share its first entity (or, when it is
    gone, the campaigns open now). The starter card names the campaign by one of its
    cases (polish round PB4): the campaign that holds that case now, whatever newer
    campaigns exist. The legacy wordings name it by id, or as "the most recently active
    campaign" (the first open one ``list_campaigns`` lists)."""
    case_ref = str(ask.slot("case") or "")
    if case_ref:
        if done == 0:
            return [Call("list_campaigns", {"case_id": case_ref})]
        row = _first_row(_held_campaign(view, case_ref))
        if done == 1 and row is None:
            return [Call("list_campaigns", {"status": "open", "limit": 5})]
        if done == 1:
            entity = _campaign_entity(row)
            return [Call("search_cases", {"entity": entity.split(":", 1)[1].strip(), "sort_field": "risk_score",
                                          "limit": 10})] if entity else []
        return []
    campaign_id = str(ask.slot("campaign") or "")
    if not campaign_id:
        if done == 0:
            return [Call("list_campaigns", {"status": "open", "limit": 1})]
        row = _open_campaign(view)
        entity = _campaign_entity(row) if row is not None else None
        if done == 1 and entity:
            return [Call("search_cases", {"entity": entity.split(":", 1)[1].strip(), "sort_field": "risk_score",
                                          "limit": 10})]
        return []
    if done == 0:
        return [Call("list_campaigns", {"campaign_id": campaign_id})]
    row = _campaign_row(view, campaign_id)
    if done == 1 and row is None:
        return [Call("list_campaigns", {"status": "open", "limit": 5})]
    if done == 1 or (done == 2 and row is None):
        row = row or _open_campaign(view)
        entity = _campaign_entity(row) if row is not None else None
        return [Call("search_cases", {"entity": entity.split(":", 1)[1].strip(), "sort_field": "risk_score",
                                      "limit": 10})] if entity else []
    return []


def _open_campaign(view: PromptView) -> Mapping[str, Any] | None:
    """The first campaign the "open now" listing returned (when the asked one is gone)."""
    current = view.ok("list_campaigns", where=lambda r: r.input.get("status") == "open")
    rows = [c for c in (current.obs.get("campaigns") if current else None) or [] if isinstance(c, Mapping)]
    return rows[0] if rows else None


def _campaign_entity(row: Mapping[str, Any]) -> str | None:
    entity = next((e for e in row.get("entities") or [] if isinstance(e, str) and ":" in e), None)
    return entity if entity and entity.split(":", 1)[1].strip() else None


def _technique_rule_counts(view: PromptView, technique: str) -> list[tuple[str, int]]:
    """``(rule, cases)`` of the cases that carry ``technique``, most cases first (from
    the technique-by-rule breakdown, exact)."""
    stats = view.ok("case_stats", where=lambda r: r.input.get("group_by") == ["mitre_technique", "rule"])
    counts: dict[str, float] = {}
    for group in (stats.obs.get("groups") if stats else None) or []:
        key = group.get("key") if isinstance(group, Mapping) else None
        if not isinstance(key, Mapping) or key.get("mitre_technique") != technique:
            continue
        rule = key.get("rule")
        if isinstance(rule, str) and rule.strip():
            counts[rule] = counts.get(rule, 0) + (_num(_dig(group, "metrics", "count")) or 0)
    return [(rule, int(n)) for rule, n in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))]


def _technique_rules(view: PromptView, technique: str) -> list[str]:
    """The rules of the cases that carry ``technique``, most cases first."""
    return [rule for rule, _n in _technique_rule_counts(view, technique)]


#: The rules whose cases a "which cases show T…" answer lists (chat's case lookups
#: cannot filter by technique, so it lists the cases of the rules that carry it).
_TECHNIQUE_LIST_RULES = 3


def _technique_cases_part(view: PromptView, technique: str, count: int) -> list[str]:
    """What the cases that carry ``technique`` are: the exact count by rule, then the
    highest-risk cases of its top rules, naming which part of the count they are."""
    by_rule = _technique_rule_counts(view, technique)
    body: list[str] = []
    if len(by_rule) > 1:
        shown = by_rule[:4]
        rest = len(by_rule) - len(shown)
        body.append("By rule: " + _join([f"{_code(rule)} {_count(n)}" for rule, n in shown]
                                        + ([f"{rest} more {'rule' if rest == 1 else 'rules'}"] if rest else [])) + ".")
    searched = [r for r in view.results() if r.tool == "search_cases" and r.ok and r.input.get("rule")]
    rules = {str(r.input.get("rule")) for r in searched}
    rows: dict[str, Mapping[str, Any]] = {}
    for result in searched:
        for case in result.obs.get("cases") or []:
            if isinstance(case, Mapping) and case.get("case_id"):
                rows.setdefault(str(case["case_id"]), case)
    if not rows:
        return body
    covered = sum(n for rule, n in by_rule if rule in rules)
    ranked = sorted(rows.values(), key=lambda c: -(_num(c.get("risk_score")) or 0))
    listed = min(len(ranked), 5)
    # A list shorter than the count always says which part of the count it is.
    if covered >= count and listed >= count:
        body.append("Its case:" if listed == 1 else "Its cases, highest risk first:")
    elif covered >= count:
        body.append(f"The {_count(listed)} highest-risk of the {_count(count)}:")
    else:
        top = "its top rule" if len(rules) == 1 else f"its top {_count(len(rules))} rules"
        body.append(f"The {_count(listed)} highest-risk {'case' if listed == 1 else 'cases'} from {top}, which "
                    f"hold {_count(covered)} of the {_count(count)}:")
    body.extend(f"- {_case_line(c)}" for c in ranked[:listed])
    return body


_RULE_ORDINALS = ("top", "second", "third", "fourth", "fifth")


def _technique_case_blocks(view: PromptView, technique: str) -> list[dict[str, Any] | None]:
    """One case list per rule the answer searched (the order of its "By rule" line),
    each titled for the technique, so the blocks hold every case the prose lists."""
    searched = [r for r in view.results() if r.tool == "search_cases" and r.ok and r.input.get("rule")
                and _num(r.obs.get("count"))]
    name = display_text(technique, 12)
    return [_block(r, "case_list", view="case_list",
                   title=f"Cases with {name}" if len(searched) == 1
                   else f"Cases with {name} from its {_RULE_ORDINALS[min(i, len(_RULE_ORDINALS) - 1)]} rule")
            for i, r in enumerate(searched)]


def _hunt_count_call(technique: str) -> Call:
    return Call("case_stats", {"window": "now-7d", "group_by": ["mitre_technique"]})


def _plan_technique_hunt(view: PromptView, ask: Ask, done: int) -> list[Call]:
    """The technique, the exact number of cases of the last 7 days that carry it (the
    window the card counted) and their rules, then the cases of its main rule and what
    the main entity of the riskiest of them did in the logs over the same 7 days."""
    technique = ask.techniques[0] if ask.techniques else ""
    if done == 0:
        calls = [Call("mitre_lookup", {"ids": [technique]})]
        if view.can("case_stats"):
            calls.append(_hunt_count_call(technique))
            calls.append(Call("case_stats", {"window": "now-7d", "group_by": ["mitre_technique", "rule"]}))
        return calls
    if done == 1:
        rules = _technique_rules(view, technique)
        if not rules:
            return []
        return [Call("search_cases", {"rule": rules[0], "window": "now-7d", "sort_field": "risk_score", "limit": 5})]
    if done == 2:
        top = _newest_case(view.ok("search_cases"))
        entity = _entity_of({"case": top}) if top else None
        if entity is None:
            return []
        call = _entity_log_call(entity[0], entity[1], ask, view, default=168)
        return [call] if call is not None else [Call("search_logs", {"contains": entity[1], **_log_window(ask, view, 168)})]
    return []


def _plan_case_entity(view: PromptView, ask: Ask, done: int) -> list[Call]:
    """The case, then what its main entity did in the logs over the last 24 hours and
    the other cases on it."""
    if done == 0:
        return [Call("get_case", {})]
    if done == 1:
        got = view.ok("get_case")
        entity = _entity_of(got.obs) if got else None
        if entity is None:
            return []
        kind, value = entity
        log_call = _entity_log_call(kind, value, ask, view, default=24)
        if log_call is not None and ask.slot("group"):
            # "Break this down by source IP instead": the same activity, split by it.
            return [Call("log_stats", {**log_call.input, "group_by": [str(ask.slot("group"))]})]
        if ask.slot("compare"):
            # "Compare this with the previous 24 hours": the entity's activity over
            # the window the chip names, with the period before it.
            return [Call("log_stats", {**log_call.input, "compare": "previous_period"})] if log_call else []
        log_call = log_call or Call("search_logs", {"contains": value, **_log_window(ask, view, default=24)})
        return [log_call, Call("search_cases", {"entity": value, "sort_field": "risk_score", "limit": 10})]
    return []


def _plan_case_related(view: PromptView, ask: Ask, done: int) -> list[Call]:
    """The case, then every case on its main entity and the campaigns that link it."""
    if done == 0:
        return [Call("get_case", {"case_id": ask.case_id} if ask.case_id else {})]
    if done == 1:
        got = view.ok("get_case")
        entity = _entity_of(got.obs) if got else None
        calls = [Call("search_cases", {"entity": entity[1], "sort_field": "risk_score", "limit": 10})] if entity else []
        if view.can("list_campaigns"):
            calls.append(Call("list_campaigns", {"limit": 10}))
        return calls
    return []


# --------------------------------------------------------------------------- #
# Round 13 (SPEC-chat §4.1, T4): follow-up chips answered for what they name. A
# chip (the engine's deterministic chips and this planner's own) refers back to the
# answer it sits under ("the top host in this answer", "this IP address", "these
# cases"): the plan re-reads that answer's lookup THIS turn, then looks up the value
# it returned, so a value is only ever used after a lookup of this turn returned it.
# --------------------------------------------------------------------------- #
_CHIP_FIELD_WORDS: dict[str, str] = {
    "source ip": "ip", "ip address": "ip", "ip": "ip", "user": "user", "host": "host", "domain": "domain",
    "url": "url", "file hash": "hash", "file": "hash", "email address": "email", "process": "process",
}
_TOP_IN_ANSWER_RE = re.compile(
    r"^investigate the top (?P<field>source ip|user|host|domain|url|file hash|email address|process) "
    r"in this answer\??$")
_TOP_CASES_RE = re.compile(r"^which cases involve the top (?P<field>source ip|user|host)\b")
_ENTITY_MORE_RE = re.compile(
    r"^what else did this (?P<field>ip address|host|user|domain|url|file|email address|process) do\b")
_INDICATOR_EVENTS_RE = re.compile(r"^show every log event for this indicator\b")
_THESE_OPEN_RE = re.compile(r"^which of these cases are still open(?:,? and who has them)?\??$")
_SHARE_ENTITY_RE = re.compile(r"^which (?:other )?cases share (?:an entity|entities) with\b")
_SHARE_THIS_RE = re.compile(r"\bwith (?:this (?:one|case)|it)\??$")
_CASE_STATUS_CHANGES_RE = re.compile(r"^show the case status changes\b")
_SOURCE_CASES_RE = re.compile(r"^how many cases came from (?P<name>.+?)\??$", re.IGNORECASE)
_TECHNIQUE_CASES_RE = re.compile(
    r"^(?:which (?:other )?cases show (?P<a>t\d{4}(?:\.\d{3})?)|explain (?P<b>t\d{4}(?:\.\d{3})?) and whether "
    r"other cases show it)\??$")
_TECHNIQUE_HUNT_RE = re.compile(r"^hunt for more activity of (?:att&ck technique )?(?P<t>t\d{4}(?:\.\d{3})?)\b")
_VERDICT_CASES_RE = re.compile(
    r"^(?:which cases drove the (?P<a>false|true)-positive rate|list the (?P<b>false|true) positives"
    r"(?P<rule> from this rule)?|which rules drove the (?P<c>false|true) positives)\b")
_TOP_GROUP_RE = re.compile(
    r"^list the cases (?:behind|from) the top (?P<dim>severity|verdict|status|rule|assignee|priority|source)\b")
_COMPARE_CHIP_RE = re.compile(r"^compare this with the previous [a-z0-9 ]{2,20}\??$")
_SOURCE_EVENTS_RE = re.compile(r"^show recent events from (?P<name>.+?)\??$", re.IGNORECASE)
_CHIP_REWRITES: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"^which open cases push the active risk index up\??$"), "Show the top 10 open cases by risk"),
    (re.compile(r"^which actions did analysts take(?P<rest>.*?)\??$"), "Show the audit trail{rest}"),
    (re.compile(r"^which (?P<dim>severity|verdict|rule|assignee|status) changed most (?P<rest>.+?)\??$"),
     "Compare cases by {dim} {rest} with the previous period"),
    (re.compile(r"^which (?P<dim>assignee|rule|severity|verdict|source) has the most (?P<open>open )?cases\??$"),
     "How many {open}cases are there by {dim}?"),
)


def _latest_calls(view: PromptView) -> list[PriorCall]:
    """The lookups of the latest earlier answer (the one a chip sits under)."""
    latest = view.prior_calls[-1].key if view.prior_calls else None
    return [c for c in view.prior_calls if c.key == latest]


def _prior_grouped(view: PromptView, field_key: str) -> PriorCall | None:
    """The latest earlier lookup that ranked ``field_key`` (a log or case breakdown)."""
    for call in reversed(view.prior_calls):
        groups = [g.strip() for g in (call.arg("group_by") or "").split(",")]
        if call.tool in ("log_stats", "case_stats") and field_key in groups:
            return call
    return None


def _prior_entity(view: PromptView, kind: str) -> str | None:
    """The value of ``kind`` the latest earlier answer looked up (its own filter: the
    analyst's typed value or a lookup's), else None."""
    keys = {"ip": ("ip", "indicator", "entity"), "user": ("user", "entity"), "host": ("host", "entity"),
            "domain": ("indicator", "contains", "entity"), "url": ("indicator", "contains"),
            "hash": ("indicator", "contains"), "email": ("contains", "entity"), "process": ("contains",)}
    for call in reversed(_latest_calls(view)):
        for key in keys.get(kind, ()):
            value = call.arg(key)
            if not value or value.startswith(("{", "[")):
                continue
            if key == "indicator" and call.arg("kind") not in (None, kind, "hash" if kind == "hash" else kind):
                continue
            if key == "entity" and ":" in value:
                ekind, _sep, value = value.partition(":")
                if ekind.strip().lower() != kind:
                    continue
            return value.strip()[:256] or None
    return None


def _prior_indicator(view: PromptView) -> tuple[str, str] | None:
    """``(kind, value)`` of the indicator the latest earlier answer looked up."""
    for call in reversed(_latest_calls(view)):
        value, kind = call.arg("indicator"), call.arg("kind")
        if value and kind:
            return ({"hash": "hash"}.get(kind, kind), value.strip()[:256])
    for kind in ("ip", "user", "host"):
        value = _prior_entity(view, kind)
        if value:
            return kind, value
    return None


#: A question about the caller's own cases ("my open cases", "assigned to me").
#: "My cases", "my open critical cases", "my closed incidents", "cases assigned to me":
#: up to three words between "my" and the noun (never "my team's cases").
_MY_CASES_RE = re.compile(r"\bmy (?:[a-z-]+ ){0,3}(?:cases?|incidents?)\b|\bassigned to me\b")
_SLA_BREACH_RE = re.compile(
    r"\b(?:past|over|breach\w*|overdue)\b[^.?!]{0,30}\b(?:sla|response target)s?\b"
    r"|\b(?:sla|response target)s?\b[^.?!]{0,20}\b(?:breach\w*|overdue|oldest)\b")
_REBUCKET_CASES_RE = re.compile(r"^show (?:these|the same) cases\b.*\bby (?P<bucket>hour|day|week|month)\??$")
_REGROUP_CASES_RE = re.compile(r"^break (?:this|that) down by (?P<dim>severity|rule|verdict|assignee|source|status) "
                               r"instead\??$")


_SLA_FILTERS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"\b(?:my|mine|assigned to me)\b"), "cannot tell which cases are yours, so this counts every open case "
                                                     "past its response target, not only yours"),
    (re.compile(r"\b(?P<w>critical|high|medium|low)\b(?![- ]?(?:est|er)\b)"),
     "cannot filter by severity, so this counts every open case past its response target, not only {w} ones"),
    (re.compile(r"\b(?P<w>unassigned)\b|\bassigned to\b"),
     "cannot filter by assignee, so this counts every open case past its response target"),
    (re.compile(r"\b(?P<w>escalated|on[- ]hold|investigating|new)\b"),
     "cannot filter by status, so this counts every open case past its response target, not only {w} ones"),
    (re.compile(r"\b(?P<w>false[- ]positive|true[- ]positive|needs?[- ]human)s?\b"),
     "cannot filter by verdict, so this counts every open case past its response target"),
)


def _sla_unfiltered(low: str) -> str | None:
    """The sentence for a filter an SLA question names that the shift snapshot cannot
    apply ("Which critical cases are past their SLA?"), else None."""
    for pattern, sentence in _SLA_FILTERS:
        match = pattern.search(low)
        if match:
            word = (match.groupdict().get("w") or "").replace("-", " ")
            return f"The shift snapshot {sentence.format(w=word)}."
    return None


def _chip_ask(view: PromptView, q: str, low: str, ask: Callable[..., Ask]) -> Ask | None:
    """A follow-up chip planned for what it names (``None``: not a chip this planner
    resolves, classify it like any question)."""
    text = low.strip()
    if _SLA_BREACH_RE.search(text) and not re.search(r"\b(?:attainment|rate|percent|%)", text):
        named = ask("sla")
        if view.case_scoped:
            # "Is this case past its SLA?" in Case Manager chat: THIS case against the
            # response targets (the shift snapshot), never the whole queue.
            return ask("sla_case", case_id=None)
        if named.win is None and named.unread is None and named.compare is None:
            # "Which SLA breached cases are oldest?", "Which cases are past their SLA?":
            # the open cases past their response target NOW, most overdue first. A
            # question that names a period ("last month", "in September") is about
            # that period and is classified like any question. The snapshot cannot
            # filter: a filter the question names is said to be not applied.
            return ask("sla", starter="sla_breached", starter_slots=(("unfiltered", _sla_unfiltered(text)),))
    if _SHARE_ENTITY_RE.match(text):
        # Works without earlier lookups too: a Case Manager chat replays no digest.
        case_id = None if view.case_scoped and _SHARE_THIS_RE.search(text) else _case_id(q)
        if case_id or view.case_scoped:
            return ask("case_related", case_id=case_id)
        return None
    if _CASE_STATUS_CHANGES_RE.match(text):
        return ask("audit", starter_slots=(("action_type", "status"),))
    match = _SOURCE_CASES_RE.match(q.strip())
    if match:
        return ask("source_cases", no_lookup=True, starter_slots=(("source", match.group("name").strip()[:120]),))
    match = _TECHNIQUE_CASES_RE.match(text)
    if match:
        technique = (match.group("a") or match.group("b")).upper()
        return ask("technique_cases", techniques=(technique,), no_lookup=True,
                   starter_slots=(("explain", bool(match.group("b"))),))
    if view.case_scoped:
        scoped = _case_chat_chip(text, ask, view)
        if scoped is not None:
            return scoped
    if not view.prior_calls:
        return None
    match = _REGROUP_CASES_RE.match(text)
    if match and any(c.tool == "case_stats" for c in _latest_calls(view)) and not any(
            c.tool == "log_stats" for c in _latest_calls(view)):
        return ask("regroup_cases", group=match.group("dim"))
    match = _REBUCKET_CASES_RE.match(text)
    if match and any(c.tool == "case_stats" for c in _latest_calls(view)):
        # "Show these cases in the last 7 days by day": the earlier breakdown's filters
        # and window, over time instead of by a field.
        return ask("regroup_cases", group=None, bucket=match.group("bucket"))
    match = _TOP_IN_ANSWER_RE.match(text) or _TOP_CASES_RE.match(text)
    if match:
        kind = _CHIP_FIELD_WORDS[match.group("field")]
        if _prior_grouped(view, kind) is None:
            return None
        return ask("top_entity", field=kind, no_lookup=True,
                   starter_slots=(("cases_first", match.re is _TOP_CASES_RE),))
    match = _ENTITY_MORE_RE.match(text)
    if match:
        kind = _CHIP_FIELD_WORDS[match.group("field")]
        value = _prior_entity(view, kind)
        # The case the earlier answer was about is not "something else" this entity
        # did: its other cases are counted without it.
        own = next((c.arg("case_id") for c in reversed(_latest_calls(view))
                    if c.tool in ("get_case", "explain_decision") and c.arg("case_id")), None)
        return ask("entity_more", field=kind, no_lookup=True,
                   starter_slots=(("value", value), ("own_case", own))) if value else None
    if _INDICATOR_EVENTS_RE.match(text):
        found = _prior_indicator(view)
        return ask("entity_more", field=found[0], no_lookup=True,
                   starter_slots=(("value", found[1]), ("events_only", True))) if found else None
    if _THESE_OPEN_RE.match(text):
        if not any(c.tool == "search_cases" for c in _latest_calls(view)):
            return None
        return ask("these_open")
    match = _TECHNIQUE_HUNT_RE.match(text)
    if match:
        return ask("technique_hunt", techniques=(match.group("t").upper(),), no_lookup=True)
    match = _VERDICT_CASES_RE.match(text)
    if match:
        word = match.group("a") or match.group("b") or match.group("c")
        rule = None
        if match.group("rule"):
            rule = next((c.arg("rule") for c in reversed(view.prior_calls) if c.arg("rule")), None)
            if not rule:
                return None
        return ask("verdict_cases", starter_slots=(("verdict", f"{word.upper()}_POSITIVE"), ("rule", rule),
                                                   ("by_rule", bool(match.group("c")))))
    match = _TOP_GROUP_RE.match(text)
    if match:
        dim = match.group("dim")
        if not any(c.tool == "case_stats" and dim in (c.arg("group_by") or "").split(",") for c in view.prior_calls):
            return None
        return ask("top_group_cases", group=dim)
    if _COMPARE_CHIP_RE.match(text):
        latest = _latest_calls(view)
        if any(c.tool in ("log_stats", "cost_usage") for c in latest) and not any(
                c.tool in ("case_stats", "soc_metrics") for c in latest):
            return ask("rerun", compare="previous_period")
        if not any(c.tool == "soc_metrics" for c in latest) and _compare_prior(view) is not None:
            # Under a case count or a case list: THOSE cases (the earlier lookup's own
            # filters and window) against the period before, never every case.
            return ask("compare_cases", compare="previous_period", compare_win=None, win=None, hours=None)
        return None
    match = _SOURCE_EVENTS_RE.match(q.strip())
    if match and any(c.tool == "source_health" for c in view.prior_calls):
        return ask("source_events", no_lookup=True, starter_slots=(("source", match.group("name").strip()[:120]),))
    return None


_SHOW_SAME_FOR_RE = re.compile(r"^show the same for the (?:last|past) [a-z0-9 ]{2,20}\??$")
_REGROUP_LOG_RE = re.compile(r"^break this down by (?P<dim>source ip|user|host|event action) instead\??$")
_REGROUP_LOG_KEYS = {"source ip": "ip", "user": "user", "host": "host", "event action": "action"}


def _case_chat_chip(text: str, ask: Callable[..., Ask], view: PromptView) -> Ask | None:
    """The engine's chips under a Case Manager answer. That chat replays no lookup
    digest, and its only windowed or ranked figures are the case's main entity's log
    activity (the case_entity answer, the brief and their comparisons), so each chip is
    answered for that entity, for this case. A chip that names no window ("Break this
    down by source IP instead") keeps the window of the latest earlier question that
    named one ("Show the same for the last 7 days")."""
    earlier = next((w for w in (_window_from(q.strip().lower()) for q in reversed(view.prior_questions))
                    if w is not None and w.spec is not None), None)
    held: dict[str, Any] = {"win": earlier, "hours": earlier.hours} if earlier is not None else {}
    if _COMPARE_CHIP_RE.match(text):
        # "Compare this with the previous 24 hours": that activity against the period
        # before it.
        return ask("case_entity", compare="previous_period", compare_win=None,
                   starter_slots=(("compare", True),))
    if _SHOW_SAME_FOR_RE.match(text):
        # After a comparison (the engine's "next window" chip): the same comparison over
        # the window named; otherwise (a widening chip) the same activity over it.
        last = view.prior_questions[-1].strip().lower() if view.prior_questions else ""
        if _COMPARE_CHIP_RE.match(last) or _SHOW_SAME_FOR_RE.match(last):
            return ask("case_entity", compare="previous_period", compare_win=None,
                       starter_slots=(("compare", True),))
        return ask("case_entity")
    match = _REGROUP_LOG_RE.match(text)
    if match:
        return ask("case_entity", starter_slots=(("group", _REGROUP_LOG_KEYS[match.group("dim")]),), **held)
    if _ENTITY_MORE_RE.match(text):
        # "What else did this user do in the last 7 days?" under the case's entity card.
        return ask("case_entity")
    if _THESE_OPEN_RE.match(text):
        # Under the cases on the case's main entity (the only case list a case chat shows).
        return ask("these_open", starter_slots=(("case_scope", True),))
    match = _REGROUP_CASES_RE.match(text)
    if match:
        # Under the open cases on the case's main entity (the only case breakdown a case
        # chat shows), split another way.
        return ask("regroup_cases", group=match.group("dim"), starter_slots=(("case_scope", True),))
    match = _REBUCKET_CASES_RE.match(text)
    if match:
        # The same open cases over time instead of by a field.
        return ask("regroup_cases", group=None, bucket=match.group("bucket"), starter_slots=(("case_scope", True),))
    match = _TOP_IN_ANSWER_RE.match(text)
    if match and _CHIP_FIELD_WORDS[match.group("field")] in ("ip", "user", "host"):
        return ask("top_entity", field=_CHIP_FIELD_WORDS[match.group("field")], no_lookup=True,
                   starter_slots=(("case_scope", True),), **held)
    return None


def _chip_rewrite(low: str) -> str | None:
    """A chip whose words the planner answers better in other words (the same
    question, worded as the planner already plans it)."""
    match = re.match(r"^show the (?P<dim>severity|verdict|rule|assignee|status|source) breakdown as a trend"
                     r"(?P<rest>.*?)\??$", low.strip())
    if match:
        rest = match.group("rest").strip()
        bucket = ("hour" if re.search(r"\b(?:24 hours|today|hour)\b", rest) else
                  "day" if re.search(r"\b(?:\d+ days|week|this month|last month)\b", rest) else "month")
        return f"Show cases by {match.group('dim')} per {bucket} {rest or 'over all time'}".strip()
    for pattern, template in _CHIP_REWRITES:
        match = pattern.match(low.strip())
        if match:
            return template.format(**{k: v or "" for k, v in match.groupdict().items()})
    return None


def _plan_top_entity(view: PromptView, ask: Ask, done: int) -> list[Call]:
    """The earlier ranking re-read this turn, then what its top value did in the logs
    and the cases on it (the value comes from this turn's lookup)."""
    kind = ask.field or "host"
    if ask.slot("case_scope"):
        return _plan_case_top_entity(view, ask, done, kind)
    prior = _prior_grouped(view, kind)
    if prior is None:
        return []
    if done == 0:
        inp = _rerun_input(prior, replace(ask, win=None), view)
        inp["group_by"] = [kind]
        return [Call(prior.tool, inp)]
    if done == 1:
        value = _top_value(view, kind)
        if value is None:
            return []
        window = {k: v for k, v in (view.results()[0].input if view.results() else {}).items()
                  if k in ("time_from", "time_to", "window", "window_hours")}
        log_filter = {"ip": {"ip": value}, "host": {"host": value}, "user": {"user": value}}.get(
            kind, {"contains": value})
        log_window = {k: v for k, v in window.items() if k in ("time_from", "time_to")} or {"time_from": "now-24h"}
        return [Call("search_logs", {**log_filter, **log_window}),
                Call("search_cases", {"entity": value, "sort_field": "risk_score", "limit": 10})]
    return []


def _plan_case_top_entity(view: PromptView, ask: Ask, done: int, kind: str) -> list[Call]:
    """In a Case Manager chat: the case, its main entity's log activity ranked by
    ``kind`` (the answer the chip sits under), then what the top value did and the
    cases on it (the value comes from this turn's lookup)."""
    if done == 0:
        return [Call("get_case", {})]
    if done == 1:
        got = view.ok("get_case")
        entity = _entity_of(got.obs) if got else None
        log_call = _entity_log_call(entity[0], entity[1], ask, view, default=24) if entity else None
        return [Call("log_stats", {**log_call.input, "group_by": [kind]})] if log_call else []
    if done == 2:
        value = _top_value(view, kind)
        ranking = _ranking(view)
        if value is None or ranking is None:
            return []
        window = {k: v for k, v in ranking.input.items() if k in ("time_from", "time_to")} or {"time_from": "now-24h"}
        log_filter = {kind: value} if kind in ("ip", "host", "user") else {"contains": value}
        return [Call("search_logs", {**log_filter, **window}),
                Call("search_cases", {"entity": value, "sort_field": "risk_score", "limit": 10})]
    return []


def _ranking(view: PromptView) -> Result | None:
    """This turn's ranking: its first log or case breakdown (after the case lookup of a
    Case Manager chat)."""
    return next((r for r in view.results() if r.tool in ("log_stats", "case_stats")), None)


def _top_value(view: PromptView, kind: str) -> str | None:
    """The top value of ``kind`` this turn's ranking returned."""
    first = _ranking(view)
    if first is None or not first.ok:
        return None
    if first.tool == "log_stats":
        rows = _dig(first.obs, "top", kind) or []
        row = next((r for r in rows if isinstance(r, Mapping) and isinstance(r.get("value"), str)), None)
        return row["value"].strip()[:256] if row else None
    groups = _stats_groups(first.obs)
    best = max(groups, key=lambda g: _num(_dig(g, "metrics", "count")) or 0, default=None)
    value = _dig(best, "key", kind) if best else None
    return value.strip()[:256] if isinstance(value, str) and value.strip() else None


def _plan_entity_more(view: PromptView, ask: Ask, done: int) -> list[Call]:
    """What the value the earlier answer looked up did over the chip's window."""
    value, kind = ask.slot("value"), ask.field or "ip"
    if done or not value:
        return []
    window = _log_window(ask, view, default=168)
    log_filter = {"ip": {"ip": value}, "host": {"host": value}, "user": {"user": value}}.get(kind, {"contains": value})
    calls = [Call("search_logs", {**log_filter, **window})]
    if not ask.slot("events_only"):
        stats = _entity_log_call(kind, value, ask, view, default=168)
        if stats is not None:
            calls.append(stats)
        calls.append(Call("search_cases", {"entity": value, "sort_field": "risk_score", "limit": 10}))
    return calls


def _plan_regroup_cases(view: PromptView, ask: Ask, done: int) -> list[Call]:
    """The earlier case breakdown again, grouped by the field the chip names instead."""
    if ask.slot("case_scope"):
        if done == 0:
            return [Call("get_case", {})]
        got = view.ok("get_case")
        entity = _entity_of(got.obs) if got else None
        if done != 1 or entity is None:
            return []
        inp: dict[str, Any] = {"entity": entity[1], "status_group": "active"}
        if ask.group is None and ask.bucket:
            return [Call("case_stats", {**inp, "bucket": ask.bucket, **_windowed(ask, view)})]
        inp["group_by"] = [ask.group or "severity"]
        if ask.group in ("rule", "assignee", "source"):
            inp["top_n"] = 10
        return [Call("case_stats", inp)]
    prior = next((c for c in reversed(_latest_calls(view)) if c.tool == "case_stats"), None)
    if done or prior is None:
        return []
    inp = _rerun_input(prior, replace(ask, win=None), view, ("group_by", "bucket", "top_n", "metrics"))
    if ask.group is None and ask.bucket:
        inp["bucket"] = ask.bucket
        return [Call("case_stats", inp)]
    inp["group_by"] = [ask.group or "severity"]
    if ask.group in ("rule", "assignee", "source"):
        inp["top_n"] = 10
    return [Call("case_stats", inp)]


def _these_open_prior(view: PromptView) -> PriorCall | None:
    """The case list "these cases" names: the latest earlier answer's last case search."""
    return next((c for c in reversed(_latest_calls(view)) if c.tool == "search_cases"), None)


def _closed_only(prior: PriorCall | None) -> bool:
    """Whether an earlier case search listed closed cases only (its own status filter)."""
    return prior is not None and (prior.arg("status_group") == "terminal"
                                  or prior.arg("status") in TERMINAL_CASE_STATUSES)


def _plan_these_open(view: PromptView, ask: Ask, done: int) -> list[Call]:
    """The earlier case list's filters, open cases only, and who has them. An open
    status the list was filtered by ("the escalated cases") stays the filter, so
    "those" never widens to the whole open queue; a list of closed cases only needs no
    lookup (none of them is open)."""
    if ask.slot("case_scope"):
        # A Case Manager chat: the cases on this case's main entity.
        if done == 0:
            return [Call("get_case", {})]
        got = view.ok("get_case")
        entity = _entity_of(got.obs) if got else None
        if done != 1 or entity is None:
            return []
        scope = {"entity": entity[1], "status_group": "active"}
        calls = [Call("search_cases", {**scope, "sort_field": "risk_score", "limit": 10})]
        if view.can("case_stats"):
            calls.append(Call("case_stats", {**scope, "group_by": ["assignee"]}))
        return calls
    prior = _these_open_prior(view)
    if done or prior is None or _closed_only(prior):
        return []
    inp = _rerun_input(prior, replace(ask, win=None), view, ("status", "status_group", "sort_field", "limit"))
    status = prior.arg("status")
    # The search takes a status or a status group, never both.
    inp.update({"status": status} if status in OPEN_CASE_STATUSES else {"status_group": "active"})
    inp.update({"sort_field": "risk_score", "limit": 10})
    stats = {k: v for k, v in inp.items() if k not in ("sort_field", "sort_order", "limit")}
    calls = [Call("search_cases", inp)]
    if view.can("case_stats"):
        calls.append(Call("case_stats", {**stats, "group_by": ["assignee"]}))
    return calls


#: A case lookup's filters (what "this" names when a compare chip sits under it).
_CASE_FILTER_KEYS = ("text", "status", "status_group", "verdict", "entity", "severity", "assignee", "rule")


def _compare_prior(view: PromptView) -> PriorCall | None:
    """The case lookup a "Compare this with the previous …" chip compares: of the
    latest answer's windowed case counts and lists (never the anchor, the clock or a
    lookup that already compared), the one with the most filters, a breakdown first."""
    rows = []
    for index, call in enumerate(_latest_calls(view)):
        window = call.arg("window")
        if call.tool not in ("case_stats", "search_cases") or call.arg("compare"):
            continue
        if not (window or call.arg("window_hours")) or window in ("all", _ANCHOR_WINDOW):
            continue  # nothing comes before all time; the anchor is context
        if call.tool == "case_stats" and window == _CLOCK_INPUT["window"] and call.arg("bucket") == "day" \
                and not any(call.arg(k) for k in (*_CASE_FILTER_KEYS, "group_by")):
            continue  # the clock lookup that dated "since 09:12"
        filters = sum(1 for k in _CASE_FILTER_KEYS if call.arg(k))
        rows.append(((filters, call.tool == "case_stats" and bool(call.arg("group_by")), -index), call))
    return max(rows, key=lambda row: row[0])[1] if rows else None


def _plan_compare_cases(view: PromptView, ask: Ask, done: int) -> list[Call]:
    """The earlier case lookup's filters and window, counted against the period
    before (and split as it was split, else by severity)."""
    prior = _compare_prior(view)
    if done or prior is None:
        return []
    base = _rerun_input(prior, replace(ask, win=None, compare=None), view,
                        ("group_by", "bucket", "metrics", "top_n", "sort_field", "limit"))
    base.pop("sort_order", None)
    filters = {k: v for k, v in base.items() if k in _CASE_FILTER_KEYS}
    # A rate over cases already filtered to one verdict says nothing (always 0 or 100%),
    # nor does a false-positive rate over open cases (mostly not decided yet).
    open_only = filters.get("status_group") == "active" or filters.get("status") in OPEN_CASE_STATUSES
    metrics = ["count"] if filters.get("verdict") or open_only else ["count", "fp_rate"]
    group = (prior.arg("group_by") or "").split(",")[0].strip() if prior.tool == "case_stats" else ""
    if not group or group in filters:
        group = _compare_group(replace(ask, group=None), filters)
    return [Call("case_stats", {**base, "metrics": metrics, "compare": "previous_period"}),
            Call("case_stats", {**base, "group_by": [group], "compare": "previous_period"})]


def _technique_window(ask: Ask, view: PromptView) -> dict[str, Any]:
    return _windowed(ask, view) if ask.win is not None else {"window": "all"}


def _plan_technique_cases(view: PromptView, ask: Ask, done: int) -> list[Call]:
    """The technique, how many cases carry it (exact) and from which rules, then the
    cases of its main rule."""
    technique = ask.techniques[0] if ask.techniques else ""
    window = _technique_window(ask, view)
    if done == 0:
        calls = [Call("mitre_lookup", {"ids": [technique]})]
        if view.can("case_stats"):
            calls.append(Call("case_stats", {**window, "group_by": ["mitre_technique"]}))
            calls.append(Call("case_stats", {**window, "group_by": ["mitre_technique", "rule"]}))
        return calls
    if done == 1:
        # Chat's case search cannot filter by technique: the cases of the rules that
        # carry it (most cases first), each rule's list as long as its share.
        return [Call("search_cases", {"rule": rule, **window, "sort_field": "risk_score", "limit": max(1, min(5, n))})
                for rule, n in _technique_rule_counts(view, technique)[:_TECHNIQUE_LIST_RULES]]
    return []


def _plan_verdict_cases(view: PromptView, ask: Ask, done: int) -> list[Call]:
    """The cases of one verdict over the window, and the rules they came from."""
    if done:
        return []
    filters: dict[str, Any] = {"verdict": ask.slot("verdict")}
    if ask.slot("rule"):
        filters["rule"] = ask.slot("rule")
    window = _windowed(ask, view)
    calls = [Call("search_cases", {**filters, **window, "sort_field": "risk_score", "limit": 10})]
    if view.can("case_stats") and not ask.slot("rule"):
        calls.append(Call("case_stats", {**filters, **window, "group_by": ["rule"], "top_n": 5}))
    return calls


#: A case breakdown's display label back to the filter value ("False positive" →
#: FALSE_POSITIVE, "Low" → low, "On hold" → on_hold).
def _group_filter_value(dim: str, label: str) -> str:
    if dim == "verdict":
        return label.strip().upper().replace(" ", "_")
    if dim in ("severity", "status", "priority"):
        return label.strip().lower().replace(" ", "_")
    return label.strip()


def _plan_top_group_cases(view: PromptView, ask: Ask, done: int) -> list[Call]:
    """The earlier case breakdown re-read this turn, then the cases of its top group."""
    dim = ask.group or "severity"
    prior = next((c for c in reversed(view.prior_calls) if c.tool == "case_stats"
                  and dim in (c.arg("group_by") or "").split(",")), None)
    if prior is None:
        return []
    if done == 0:
        inp = _rerun_input(prior, replace(ask, win=None), view, ("bucket", "metrics", "compare"))
        inp["group_by"] = [dim]
        return [Call("case_stats", inp)]
    if done == 1:
        stats = view.ok("case_stats")
        groups = [g for g in (_stats_groups(stats.obs) if stats else []) if g.get("bucket") is None]
        best = max(groups, key=lambda g: _num(_dig(g, "metrics", "count")) or 0, default=None)
        label = _dig(best, "key", dim) if best else None
        if not isinstance(label, str) or not label.strip() or label.lower() in ("other", "unassigned", "none"):
            return []
        filters = {k: v for k, v in stats.input.items() if k in _RERUN_KEYS["search_cases"]
                   and k not in ("sort_field", "limit")}
        window = {k: v for k, v in stats.input.items() if k in ("window", "window_hours")}
        filters[dim if dim != "source" else "text"] = _group_filter_value(dim, label)
        return [Call("search_cases", {**filters, **window, "sort_field": "risk_score", "limit": 10})]
    return []


def _plan_source_events(view: PromptView, ask: Ask, done: int) -> list[Call]:
    """The source by its name (from the source list), then its newest events."""
    if done == 0:
        return [Call("source_health", {})]
    if done == 1:
        row = _named_source(view, str(ask.slot("source") or ""))
        if row is None or not isinstance(row.get("source_id"), str):
            return []
        return [Call("search_logs", {"source_id": row["source_id"], **_log_window(ask, view, default=24)})]
    return []


def _plan_source_cases(view: PromptView, ask: Ask, done: int) -> list[Call]:
    """The source list (to find the named source's id) and the exact case count by
    source; chat's case lookups cannot list one source's cases."""
    if done:
        return []
    return [Call("source_health", {}), Call("case_stats", {"group_by": ["source"], "top_n": 20, **_windowed(ask, view)})]


def _named_source(view: PromptView, name: str) -> Mapping[str, Any] | None:
    """The configured source named ``name``: by its whole name, else (an analyst's own
    words, "investigate source wazuh", polish round PB6) the one source whose name has
    that word or whose type it is."""
    health = view.ok("source_health")
    wanted = name.strip().lower()
    rows = [r for r in (health.obs.get("sources") if health else None) or [] if isinstance(r, Mapping)]
    for row in rows:
        if str(row.get("name") or "").strip().lower() == wanted:
            return row
    if not wanted:
        return None
    word = re.compile(rf"(?<![\w-]){re.escape(wanted)}(?![\w-])")
    loose = [r for r in rows if word.search(str(r.get("name") or "").lower())
             or str(r.get("type") or "").strip().lower() == wanted]
    return loose[0] if len(loose) == 1 else None


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
    inp: dict[str, Any] = {"group_by": [a.field or "host"], "top_n": _top_n(a.lowered),
                           **_log_window(a, v, default=168)}
    compare = _compare_spec(a)
    if compare is not None:
        inp["compare"] = compare
    return [Call("log_stats", inp)]


#: "Which techniques show up in our cases?": the techniques of the CASES (coverage),
#: never a corpus search for the word "cases".
_MITRE_IN_CASES_RE = re.compile(
    r"\b(?:our|in (?:our|the|my) cases|show(?:s|ing)? up|seen|see most|most (?:common|seen|frequent)|"
    r"top techniques?|coverage)\b")


def _plan_mitre(view: PromptView, ask: Ask, done: int) -> list[Call]:
    """Named techniques: look them up beside the coverage. The techniques the cases
    carry: the coverage first, then its most-seen techniques. Otherwise a corpus search."""
    if ask.techniques or not _MITRE_IN_CASES_RE.search(ask.lowered):
        if done:
            return []
        return [Call("mitre_lookup", {"ids": list(ask.techniques)} if ask.techniques else {"query": _mitre_query(ask)}),
                Call("soc_metrics", {"kind": "mitre_coverage", **_metric_window(ask, view)})]
    if done == 0:
        return [Call("soc_metrics", {"kind": "mitre_coverage", **_metric_window(ask, view)})]
    if done == 1:
        coverage = view.ok("soc_metrics", "mitre_coverage")
        ids = [str(t.get("id")) for t in (coverage.obs.get("top_techniques") if coverage else None) or []
               if isinstance(t, Mapping) and isinstance(t.get("id"), str)][:5]
        return [Call("mitre_lookup", {"ids": ids})] if ids else []
    return []


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
        Call("log_stats", {"group_by": [_brute_field(a)], "contains": "fail", "top_n": 10, **_log_window(a, v)}),
        Call("search_cases", {"text": "brute", "sort_field": "created_at", "limit": 10}),
    ],
    "top": _top_calls,
    # An explicit log search: the tool's own window (the chip, else 24 h) unless the
    # question names one.
    "logs": lambda v, a: [Call("search_logs", {**dict(a.log_filter), **_log_window(a, v)})],
    "log_count": lambda v, a: [Call("log_stats", {**dict(a.log_filter), "group_by": [a.field or "host"],
                                                  "top_n": _top_n(a.lowered), **_log_window(a, v)})],
    "summary": lambda v, a: [
        Call("case_stats", {"group_by": ["severity"], **_windowed(a, v)}),
        Call("case_stats", {"bucket": _natural_bucket(a.win), **_windowed(a, v)}),
        Call("soc_metrics", {"kind": "posture", **_metric_window(a, v)}),
        Call("search_cases", {"verdict": "TRUE_POSITIVE", "sort_field": "risk_score", "limit": 5,
                              **_windowed(a, v)}),
    ],
    "rate": lambda v, a: [Call("case_stats", {"group_by": ["verdict"], "metrics": [
        "count", "tp_rate", "fp_rate", "auto_closed", "human_closed"], **_windowed(a, v)})],
    "tp": lambda v, a: [
        Call("search_cases", {"verdict": "TRUE_POSITIVE", "limit": 10, **_windowed(a, v, default=24)}),
        Call("soc_metrics", {"kind": "case_mix", **_windowed(a, v, default=24)}),
    ],
    "hunt": lambda v, a: _indicator_calls(a.indicator[0], a.indicator[1], a, v, default=168)
    if a.indicator else [],
    "sources": lambda v, a: [Call("source_health", {})],
    "campaigns": lambda v, a: [Call("list_campaigns", {"status": "open"} if "open" in a.lowered else {})],
    "audit": lambda v, a: [Call("audit_search", {**_windowed(a, v), **(
        {"action_type": a.slot("action_type")} if a.slot("action_type") else {})})],
    "automation": lambda v, a: [Call("automation_status", {"kind": a.metric or "approvals"})],
    "knowledge": lambda v, a: [Call("search_knowledge", (
        {"kind": "list_runbooks"} if re.search(r"\b(list|which|what) runbooks\b", a.lowered)
        else {"kind": "list_playbooks"} if re.search(r"\b(list|which|what) playbooks\b", a.lowered)
        else {"query": a.topic or a.question}))],
    "help": lambda v, a: [
        Call("app_help", {"query": _help_query(a)}),
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
    "cases": lambda v, a: [Call("search_cases", _cases_filters(a, v)),
                           *([Call("soc_metrics", {"kind": "timing",
                                                   **_win_args("soc_metrics", a, v, "now-30d")})]
                             if _TIMING_CUE_RE.search(a.lowered) else [])],
    "change": lambda v, a: [Call("app_help", {"query": _change_query(a)})],
    "unsupported": lambda v, a: [Call("app_help", {"query": _help_hint(a) or a.question[:300]})],
    "clarify": lambda v, a: [],
    "explain_step": lambda v, a: [],
    "fallback": lambda v, a: [
        # Orientation: what chat can answer, not a keyword search for an unmapped ask.
        Call("app_help", {"query": "Workspace Chat ask a question"}),
        Call("search_cases", {"status_group": "active", "sort_field": "risk_score", "limit": 5}),
    ],
    # Round 13 starters (SPEC-chat §3.4): one lookup each.
    "budget": lambda v, a: [Call("cost_usage", {"window": "today"})],
    "approvals": lambda v, a: [Call("automation_status", {"kind": "approvals"})],
    "auto_close": lambda v, a: [Call("soc_metrics", {"kind": "auto_close_health"})],
    # The card needs only case search; the shift snapshot's attention ranking (status,
    # verdict, risk and age) is added when the caller may read it.
    "triage": lambda v, a: [Call("search_cases", {"status_group": "active", "sort_field": "risk_score", "limit": 10})]
    + ([Call("shift_report", {"attention_limit": 10})] if v.can("shift_report") else []),
    "source": lambda v, a: [Call("source_health", {})],
}

_PLANS: dict[str, Callable[[PromptView, Ask, int], list[Call]]] = {
    name: _anchored_plan(plan) for name, plan in {
        "case": _plan_case,
        "pivot": _plan_pivot,
        "reshape": _plan_reshape,
        "regroup": _plan_regroup,
        "rerun": _plan_rerun,
        "rerun_step": _plan_rerun_step,
        "breakdown": _plan_breakdown,
        "trend": _plan_trend,
        "compare": _plan_compare,
        "perf_report": _plan_perf_report,
        "brief": _plan_brief,
        "deep": _plan_deep,
        "entity_cases": _plan_entity_cases,
        "sla_case": _plan_sla_case,
        "my_cases": _plan_my_cases,
        "sla": _plan_shift_queue,
        "new_since": _plan_new_since,
        "volume": _plan_volume,
        "noisy_rule": _plan_noisy_rule,
        "campaign": _plan_campaign,
        "technique_hunt": _plan_technique_hunt,
        "top_entity": _plan_top_entity, "entity_more": _plan_entity_more, "these_open": _plan_these_open,
        "regroup_cases": _plan_regroup_cases,
        "technique_cases": _plan_technique_cases, "verdict_cases": _plan_verdict_cases,
        "top_group_cases": _plan_top_group_cases, "source_events": _plan_source_events,
        "source_cases": _plan_source_cases,
        "case_entity": _plan_case_entity,
        "compare_cases": _plan_compare_cases,
        "case_related": _plan_case_related,
        "mitre": _plan_mitre,
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
    "summary": ("case_stats", "soc_metrics", "search_cases"),
    "rate": ("case_stats",), "entity_cases": ("search_cases",),
    # Round 13 starters.
    "sla_case": ("get_case", "shift_report"), "my_cases": ("search_cases", "case_stats"), "sla": ("shift_report",),
    "new_since": ("search_cases", "case_stats"), "volume": ("case_stats",),
    "noisy_rule": ("case_stats", "search_cases"), "campaign": ("list_campaigns", "search_cases"),
    "technique_hunt": ("mitre_lookup", "case_stats", "log_stats", "search_cases"),
    "case_entity": ("get_case", "log_stats", "search_cases"), "case_related": ("get_case", "search_cases"),
    "budget": ("cost_usage",), "approvals": ("automation_status",), "auto_close": ("soc_metrics",),
    "triage": ("search_cases",), "source": ("source_health",),
    # Round 13 follow-up chips (T4).
    "top_entity": ("search_logs", "search_cases"), "entity_more": ("search_logs",),
    "these_open": ("search_cases",), "technique_cases": ("mitre_lookup", "case_stats", "search_cases"),
    "regroup_cases": ("case_stats",), "compare_cases": ("case_stats",),
    "verdict_cases": ("search_cases",), "top_group_cases": ("case_stats", "search_cases"),
    "source_events": ("source_health", "search_logs"), "source_cases": ("case_stats", "source_health"),
}
_DATA_INTENTS = frozenset(_INTENT_TOOLS) - {"rerun"}
#: Intents whose lookups take a window: only they date a period named without its
#: year (the anchor lookup). A product question, a change request, a clarify or the
#: fallback never runs a data lookup for a month it mentions (SPEC D9).
_ANCHOR_INTENTS = (_DATA_INTENTS | {"rerun", "regroup"}) - {"knowledge", "sources", "campaigns", "automation"}
_TOOL_NAMES = {
    "soc_metrics": "SOC metrics", "shift_report": "the shift snapshot", "cost_usage": "AI cost data",
    "log_stats": "log statistics", "search_logs": "log search", "search_cases": "case search",
    "case_stats": "case counts", "get_case": "case details", "explain_decision": "the decision policy",
    "lookup_indicator": "indicator reputation", "mitre_lookup": "the ATT&CK corpus", "source_health":
    "source health", "list_campaigns": "campaigns", "audit_search": "the audit trail", "automation_status":
    "automation status", "search_knowledge": "the knowledge base",
}


#: Help Center queries for questions whose own words search poorly ("How do reports
#: work?" matches "Work a case"): the product area they are about, in the corpus's
#: words. The first matching pattern wins; other export questions keep their words.
_HELP_HINTS: tuple[tuple[str, str], ...] = (
    ((r"\breports?\b.*\b(?:export\w*|pdf|download\w*|print\w*)\b|"
      r"\b(?:export\w*|pdf|download\w*|print\w*)\b.*\breports?\b"), "Workspace Chat Export report"),
    (r"\b(?:export\w*|pdf|download\w*|print\w*)\b", ""),
    ((r"\b(?:close|resolve|reopen|assign|escalate|delete|remove|edit|update|tag)\b.*\b(?:all|every|bulk)\b.*"
      r"\b(?:cases|incidents)\b|\b(?:all|every|bulk)\b.*\b(?:close|resolve|reopen|assign|escalate|delete|remove)\b"),
     "Case Manager select cases and run bulk work"),
    (r"\b(?:close|resolve|reopen|assign|escalate|delete|remove|edit|update|tag)\b.*\b(?:cases?|incidents?)\b",
     "Case Manager Take Action single-case actions"),
    (r"\breports?\b", "Workspace Chat reports"),
    (r"\bsessions?\b", "Sessions & activity active sessions"),
    (r"\b(?:users?|accounts?|roles?|analysts? list)\b", "Users and roles user accounts"),
    (r"\b(?:notifications?|channels?|alerting)\b", "Notifications configure a channel"),
    (r"\bdashboards?\b", "custom dashboards"),
    (r"\bjobs?\b", "Analytics Jobs background jobs"),
    (r"\b(?:secrets?|api keys?|credentials?)\b", "Secret keys"),
)


def _help_hint(ask: Ask) -> str:
    for pattern, query in _HELP_HINTS:
        if re.search(pattern, ask.lowered):
            return query
    return ""


#: Hints for console administration areas: a data how-to that merely mentions a user,
#: a session or a report ("How do I hunt for a user in the logs?") keeps its own topic.
_ADMIN_HINTS = frozenset({"Workspace Chat reports", "Sessions & activity active sessions",
                          "Users and roles user accounts", "Notifications configure a channel", "custom dashboards",
                          "Analytics Jobs background jobs", "Secret keys"})
_DATA_HOWTO_RE = re.compile(r"\b(?:logs?|events?|cases?|hunt\w*|search\w*|investigat\w*|alerts?|iocs?|"
                            r"indicators?|quer(?:y|ies)|sign[- ]?ins?|logins?|activity|suspicious)\b")


def _help_query(ask: Ask) -> str:
    """The Help Center query of a product question: the area hint, else its topic. An
    administration hint applies only when the question is about that area, not a data
    how-to that mentions a user or a session."""
    hint = _help_hint(ask)
    if hint in _ADMIN_HINTS and _DATA_HOWTO_RE.search(ask.lowered):
        hint = ""
    return hint or ask.topic or ask.question[:200]


def _change_query(ask: Ask) -> str:
    """The Help Center query for a change request: the action and its object, without
    ids or indicators (they would only add noise to a product-docs search)."""
    hint = _help_hint(ask)
    if hint:
        return hint
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


#: A case question about response times also reads them (over the last 30 days unless
#: a window is named), so the answer can say how long acknowledgement takes.
_TIMING_CUE_RE = re.compile(r"\b(acknowledg\w*|mtt[adr]|response times?|delay\w*)\b")
#: A case list ranked by risk: "top 10 open cases by risk", "the highest-risk cases",
#: "which cases had the highest risk", "the riskiest incidents" (lowest first when asked).
_RISK_RANK_RE = re.compile(
    r"\b(?:by|on|in order of|sorted by|ranked by|ordered by)\s+(?:their\s+)?risk\b|\briskiest\b|"
    r"\b(?:highest|most|greatest|biggest|top)[- ]risk\b|\b(?:highest|most|greatest|biggest)\s+(?:\w+\s+)?risk\b|"
    r"\brisk(?:iest)?\s+(?:score\s+)?(?:first|order|descending)\b|\b(?:lowest|least)[- ](?:risk|risky)\b")


def _cases_filters(ask: Ask, view: PromptView) -> dict[str, Any]:
    low = ask.lowered
    # "Top 10 open cases", "explain the top 3": the list is as long as the ranking asked.
    inp: dict[str, Any] = {"limit": _top_n(low)}
    inp.update(_status_filters(ask))
    entity = _case_entity(ask.question)
    if entity:
        inp["entity"] = entity
    # Whole words: "the highest risk" names no high severity, "below" no low one.
    severity = next((s for s in ("critical", "high", "medium", "low") if re.search(rf"\b{s}\b", low)), None)
    if severity:
        inp["severity"] = severity
    verdict = next((v for p, v in ((r"needs?[- ]human", "NEEDS_HUMAN"), (r"false[- ]positives?", "FALSE_POSITIVE"),
                                   (r"true[- ]positives?", "TRUE_POSITIVE")) if re.search(p, low)), None)
    if verdict and not re.search(r"\b(?:fp|tp|false[- ]positive|true[- ]positive) rates?\b", low):
        inp["verdict"] = verdict
    if re.search(r"\bunassigned\b", low):
        inp["assignee"] = "unassigned"
    if ask.mine:
        inp["assignee"] = _ASSIGNEE_ME
    if re.search(r"\b(oldest|longest|waiting|delay\w*|unacknowledged|not (?:yet )?acknowledged|backlog|aging)\b",
                 low) or (ask.win is not None and ask.win.older):
        # The cases behind an acknowledgement delay, or older than a given age: the
        # oldest first (still open unless the question names another status).
        if "status" not in inp:
            inp.setdefault("status_group", "active")
        inp.update({"sort_field": "created_at", "sort_order": "asc"})
    elif _RISK_RANK_RE.search(low):
        lowest = re.search(r"\b(?:lowest|least)[- ](?:risk|risky)\b", low)
        inp.update({"sort_field": "risk_score", "sort_order": "asc" if lowest else "desc"})
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
                  "NEEDS_HUMAN": "needs human"}


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
            parts.append(_code(value))
        elif key == "severity_gte":
            parts.append(f"severity {_count(value)} or higher")
        elif key == "ids":
            parts.append(f"the {_plural(value, 'requested event ID')}")
        else:
            parts.append(f"{_LOG_FIELD_NOUNS.get(key, key.replace('_', ' '))} {_code(value)}")
    return _join(parts)


def _with_coverage(text: str, coverage: str) -> str:
    """``text`` plus the source coverage in brackets, merged into a window's own
    bracket: "in the last 90 days (since 13 Jul 2026; 5 of 5 sources answered)"."""
    if not coverage:
        return text
    if text.endswith(")"):
        return f"{text[:-1]}; {coverage})"
    return f"{text} ({coverage})"


def _no_log_events(o: Mapping[str, Any], what: str) -> str:
    """The zero-match sentence of a log lookup: "No log events match `x` in the last
    24h (5 of 5 sources answered)." (``what`` empty: no filter, "No log events in …")."""
    coverage = _coverage_phrase(o)
    matched = f" match {what}" if what else ""
    return _with_coverage(f"No log events{matched} {_in(_window(o))}", coverage) + "."


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
    lead = _with_coverage(f"**{_plural(total, 'event')}** {scope + ' ' if scope else ''}{_in(window)}", coverage)
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
    text = _with_coverage(f"**{_plural(total, 'log event')}**{matched} {_in(_window(o))}", coverage) + "."
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
_MACHINE_TITLE_RE = re.compile(r"^([a-z][a-z_]{0,30}):(.+?) [\u2014\u00b7] (.+)$")


def _entity_phrase(raw: Any, limit: int = _NARRATED_CHARS) -> str:
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


#: A seeded machine title's trailing ordinal (" #2"): it tells two titles of one rule
#: and entity apart; in prose the case number does that, so it is not part of the rule.
_TITLE_ORDINAL_RE = re.compile(r"\s+#\d{1,4}$")


def _rule_ids(rules: str, limit: int = _NARRATED_CHARS) -> str:
    """Detection rule ids exactly as written, each as inline code (``demo_impossible_travel``),
    joined as the title joins them. This is the one display form a rule has in an
    answer: the case list, the case card's Rules fact, the tables, the conversation
    title and every other sentence show the id itself (Round 13 polish PB3; it replaces
    browser-QA D6's plain words, "demo impossible travel", which put two spellings of one
    rule in one answer). :func:`_code` keeps invisible characters as visible escapes, so
    no lookalike can form."""
    text = _TITLE_ORDINAL_RE.sub("", rules.strip()) if isinstance(rules, str) else ""
    ids = [part.strip() for part in text.split(",") if part.strip()]
    return ", ".join(_code(rule, limit) for rule in ids)


def _case_name(case: Mapping[str, Any], *, with_entity: bool = True) -> str:
    """A case in words for the narration (browser-QA D6): the machine title
    ``user:dsingh — identity_signin`` reads "`identity_signin` on user `dsingh`" (the
    rule id as every block shows it, :func:`_rule_ids`). The case id and the exact
    title stay in the blocks and links. Any other title is
    free text from the case, so it stays inline code (:func:`_code`): exact, with
    its punctuation (``srv_db_01``) and any lookalike character visible."""
    title = case.get("title") if isinstance(case.get("title"), str) else ""
    match = _MACHINE_TITLE_RE.match(title.strip())
    if match:
        kind, value, rules = match.groups()
        what = _rule_ids(rules) or "activity"
        return f"{what} on {_entity_phrase(f'{kind}:{value}')}" if with_entity else what
    if title.strip() and title.strip() != case.get("case_id"):
        return _code(title)
    return _entity_phrase(case.get("entity")) if with_entity else ""


def _case_ref(case: Mapping[str, Any]) -> str:
    """A case as the analyst knows it (Round 13 A8): its display number when it has
    one, else its id, as inline code (exact, lookalikes visible)."""
    number = case.get("case_number")
    return _code(number if isinstance(number, str) and number.strip() else case.get("case_id"))


def _numbered(case: Mapping[str, Any]) -> bool:
    number = case.get("case_number")
    return isinstance(number, str) and bool(number.strip())


def _upper_first(text: str) -> str:
    """``text`` with its first letter capitalised, past any bold mark, for the start of
    a sentence or a list item (sentence case). Inline code is never changed."""
    marks = len(text) - len(text.lstrip("*"))
    first = text[marks:marks + 1]
    if first.isalpha() and first.islower():
        return text[:marks] + first.upper() + text[marks + 1:]
    return text


def _case_head(case: Mapping[str, Any], *, bold: bool = True, name: str | None = None,
               start: bool = False) -> str:
    """A case as a sentence leads with it (Round 13 A8): its display number, then what
    it is about; a case with no number leads with what it is about ("identity signin
    on user `dsingh`") and keeps its internal id after it, exact but never the lead.
    ``start``: the head opens a sentence, so its first word is capitalised."""
    ref = _case_ref(case)
    name = _case_name(case) if name is None else name
    mark = "**" if bold else ""
    if _numbered(case) or not name:
        return f"{mark}{ref}{mark}" + (f" ({name})" if name else "")
    head = f"{mark}{name}{mark} ({ref})"
    return _upper_first(head) if start else head


def _asked_by_id(case: Mapping[str, Any], ask: Ask) -> str:
    """The internal id the analyst typed for ``case`` when the answer names the case by
    a different display number, else "": the answer then states that id once, beside
    the number, so the reference the analyst used is tied to the one shown."""
    asked = (ask.case_id or "").strip()
    case_id = str(case.get("case_id") or "")
    if not asked or not _numbered(case) or asked != case_id:
        return ""
    return case_id if case_id != str(case.get("case_number") or "").strip() else ""


def _case_head_as_asked(case: Mapping[str, Any], ask: Ask, **kw: Any) -> str:
    """:func:`_case_head`, with the internal id the analyst typed beside the number
    ("**`CASE-000056`** (`demo-0004`, identity signin on user `dsingh`)")."""
    typed = _asked_by_id(case, ask)
    if not typed:
        return _case_head(case, **kw)
    name = _case_name(case)
    return _case_head(case, **kw, name=f"{_code(typed)}, {name}" if name else _code(typed))


def _case_line(case: Mapping[str, Any]) -> str:
    name = _case_name(case)
    # A8: the number leads; without one, what the case is about leads and its id follows.
    bits = [_case_ref(case), name] if _numbered(case) or not name else [name, _case_ref(case)]
    bits = [b for b in bits if b]
    facts = []
    if case.get("severity"):
        facts.append(display_text(case.get("severity"), 20))
    if case.get("verdict"):
        facts.append(_verdict_word(case.get("verdict")))
    if _num(case.get("risk_score")) is not None:
        facts.append(f"risk {_count(case.get('risk_score'))}")
    if case.get("status"):
        facts.append(display_text(case.get("status"), 20).replace("_", " "))
    # A list item: its first word is capitalised (sentence case).
    return _upper_first(" · ".join(bits) + (f" ({', '.join(facts)})" if facts else ""))


# --------------------------------------------------------------------------- #
# Ties (polish round PB5). An answer calls one item the highest, the most, the oldest
# or the top only when no other item shares that figure as the answer shows it (risk
# and counts rounded the way they are written). When others do, it names them ("tied
# with `CASE-000043` for the highest risk (62)") and says how it picked the one it goes
# on with, so a tie never reads as a lead.
# --------------------------------------------------------------------------- #
def _peers(names: Sequence[str], limit: int = 3) -> str:
    """Tied items as words: "`b`", "`b` and `c`", "`b`, `c`, `d` and 2 others"."""
    names = [n for n in names if n]
    shown = list(names[:limit]) + ([_plural(len(names) - limit, "other")] if len(names) > limit else [])
    return _join(shown)


def _shown_risk(case: Mapping[str, Any]) -> str | None:
    """A case's risk as the answer writes it ("62"), or None when it has none."""
    return _count(case.get("risk_score")) if _num(case.get("risk_score")) is not None else None


def _risk_ties(rows: Sequence[Mapping[str, Any]], first: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    """The listed cases other than ``first`` whose shown risk equals ``first``'s."""
    mark = _shown_risk(first)
    return [] if mark is None else [r for r in rows if r is not first and _shown_risk(r) == mark]


def _instant(value: Any) -> datetime | None:
    """An ISO timestamp a lookup returned as an aware datetime, else None."""
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _highest_risk_lead(rows: Sequence[Mapping[str, Any]], scope: str) -> str:
    """"Start with X: it has the highest risk of your open cases." (rows ranked by
    risk). When other listed cases share that risk, the first listed is still where to
    start (the list, its block and its follow-ups all lead with it), and the lead says it
    is a tie and what sets it apart: "Start with X: it is tied with Y for the highest
    risk of your open cases (62); it was opened more recently." Without an opening time
    for each, it names the tie and nothing more."""
    first = rows[0]
    tied = _risk_ties(rows, first)
    if not tied:
        return f"Start with {_case_head(first)}: it has the highest risk {scope}."
    group = [first, *tied]
    opened = [_instant(c.get("created_at")) for c in group]
    fact = ""
    if all(t is not None for t in opened) and len(set(opened)) == len(opened):
        two = len(group) == 2
        if opened[0] == max(opened):  # type: ignore[type-var]
            fact = f"; it was opened {'more' if two else 'most'} recently"
        elif opened[0] == min(opened):  # type: ignore[type-var]
            fact = f"; it has been open {'longer' if two else 'the longest'}"
    return (f"Start with {_case_head(first)}: it is tied with {_peers([_case_ref(c) for c in tied])} for the "
            f"highest risk {scope} ({_shown_risk(first)}){fact}.")


def _top_ties(items: Sequence[tuple[str, Any]]) -> list[str]:
    """The labels of ``(label, value)`` pairs that share the largest value, in order."""
    values = [_num(v) for _l, v in items]
    known = [v for v in values if v is not None]
    if not known:
        return []
    best = max(known)
    return [label for (label, _v), v in zip(items, values) if v == best]


def _case_noun(filters: Mapping[str, Any], noun: str) -> str:
    """"open case", "escalated case", "critical false positive case"… from the search
    filters: every status, severity and verdict filter the lookup applied is named, so
    a filtered count never reads as the unfiltered one."""
    if noun != "case":
        return noun
    words: list[str] = []
    if filters.get("status_group") == "active":
        words.append("open")
    elif filters.get("status_group") == "terminal":
        words.append("closed")
    elif isinstance(filters.get("status"), str):
        words.append(display_text(filters["status"], 20).replace("_", " ").lower())
    if isinstance(filters.get("severity"), str):
        words.append(display_text(filters["severity"], 20).lower())
    if isinstance(filters.get("verdict"), str):
        words.append(_verdict_word(filters["verdict"]))
    return " ".join([*words, noun])


def _entity_about(filters: Mapping[str, Any]) -> str:
    """" involving `pnair`" when the case lookup was filtered to one entity, and
    " from rule `ssh_brute`" when it was filtered to one detection rule (Round 12
    WP-ASK), so a filtered count never reads as the unfiltered one; " assigned to you"
    for the signed-in analyst's own cases (:func:`_filters_of`)."""
    entity = filters.get("entity")
    about = f" involving {_code(entity)}" if isinstance(entity, str) and entity.strip() else ""
    rule = filters.get("rule")
    if isinstance(rule, str) and rule.strip():
        about += f" from rule {_code(rule)}"
    if filters.get("assignee") == _ASSIGNEE_ME:
        about += " assigned to you"
    return about


#: The assignee filter value that names the signed-in analyst (``search_cases`` and
#: ``case_stats`` resolve it to the caller's username on the server).
_ASSIGNEE_ME = "me"


def _filters_of(o: Mapping[str, Any]) -> Mapping[str, Any]:
    """A case lookup's filters as the observation reports them, the signed-in
    analyst's own cases named ``me`` again (the lookup reports the resolved username,
    and the answer says "assigned to you")."""
    filters = o.get("filters") if isinstance(o.get("filters"), Mapping) else {}
    if o.get("assignee_me") == ASSIGNEE_ME_OWN and filters.get("assignee"):
        return {**filters, "assignee": _ASSIGNEE_ME}
    return filters


def _say_search_cases(r: Result, *, noun: str = "case", keep: Sequence[str] = ()) -> str:
    o = r.obs
    if o.get("assignee_me") == ASSIGNEE_ME_NOBODY:
        # "My cases" with sign-in off: no count to give, never "no case matched".
        return "No analyst is signed in (sign-in is off), so chat cannot tell which cases are yours."
    count = _num(o.get("count")) or 0
    filters = _filters_of(o)
    window = o.get("window") if isinstance(o.get("window"), str) else "all time"
    when = "" if window == "all time" else f" {_in(display_text(window, 60))}"
    if not count and not _case_lower_bound(o):
        # A zero match says what was searched for and how to widen it (SPEC D10),
        # never by dropping the filter the question is about (``keep``).
        hint, _follow = _zero_suggestions(o, keep=keep)
        return (f"No {_case_noun(filters, noun)}{_entity_about(filters)} matched"
                f"{when or ' over all time'}." + (f" {hint}" if hint else ""))
    text = f"**{_plural(count, _case_noun(filters, noun))}**{_entity_about(filters)}{when}"
    bound = _case_lower_bound(o)
    if bound:
        text += f" ({bound})"
    by_status = o.get("by_status") if isinstance(o.get("by_status"), Mapping) else {}
    if by_status and count and not filters.get("status"):
        text += ": " + _join([f"{_count(n)} {display_text(s, 20).replace('_', ' ')}"
                              for s, n in sorted(by_status.items(), key=lambda kv: (-(_num(kv[1]) or 0), kv[0]))])
    return text + "."


def _say_entity_cases(r: Result, phrase: str, *, exclude: Any = None) -> str:
    """"**5 cases** involve IP `192.0.2.90`, all escalated." in one sentence; with
    ``exclude`` (the case the question is about) the OTHER cases only ("No other case
    involves it."). A lower-bound or windowed count keeps the general wording."""
    o = r.obs
    if _case_lower_bound(o) or (isinstance(o.get("window"), str) and o.get("window") != "all time"):
        return _say_search_cases(r, keep=("entity",))
    count = int(_num(o.get("count")) or 0)
    by_status = {str(k): int(_num(v) or 0) for k, v in (o.get("by_status") or {}).items()} \
        if isinstance(o.get("by_status"), Mapping) else {}
    other = exclude is not None
    if other:
        own = next((c for c in o.get("cases") or [] if isinstance(c, Mapping) and c.get("case_id") == exclude), None)
        if own is not None:
            count = max(0, count - 1)
            status = str(own.get("status") or "")
            if by_status.get(status):
                by_status[status] -= 1
    by_status = {k: v for k, v in by_status.items() if v > 0}
    if not count:
        return f"No {'other ' if other else ''}case involves {phrase}."
    noun = "other case" if other else "case"
    verb = "involves" if count == 1 else "involve"
    states = ""
    if len(by_status) == 1:
        word = next(iter(by_status)).replace("_", " ")
        states = f", {word}" if count == 1 else f", all {word}"
    elif by_status:
        states = ": " + _join([f"{_count(n)} {display_text(s, 20).replace('_', ' ')}"
                               for s, n in sorted(by_status.items(), key=lambda kv: (-kv[1], kv[0]))])
    return f"**{_plural(count, noun)}** {verb} {phrase}{states}."


def _zero_where(r: Result) -> str:
    """" in the last 7 days" for a zero case search ("" over all time)."""
    window = r.obs.get("window") if isinstance(r.obs.get("window"), str) else "all time"
    return "" if window == "all time" else f" {_in(display_text(window, 60))}"


def _zero_hint(r: Result) -> str:
    """" To widen it, …" from a zero case search's suggestions ("" without any)."""
    hint, _follow = _zero_suggestions(r.obs)
    return f" {hint}" if hint else ""


def _case_bullets(r: Result | None, limit: int = 3) -> list[str]:
    cases = [c for c in (r.obs.get("cases") if r else None) or [] if isinstance(c, Mapping)]
    return [f"- {_case_line(c)}" for c in cases[:limit]]


#: The console's risk bands on the 0-100 ladder (``webui`` ``scoreBand``).
_SCORE_BANDS: tuple[tuple[int, str], ...] = ((74, "critical"), (48, "high"), (22, "medium"))


def _whole(value: Any) -> str:
    """An integer the way the console's gauge shows it: rounded half up (T1)."""
    number = _num(value)
    if number is None:
        return "not measured"
    return f"{int(Decimal(str(number)).quantize(Decimal(1), rounding=ROUND_HALF_UP)):,}"


def _band(value: Any) -> str:
    """The risk band of a 0-100 score ("high"), or "" when it is not measured."""
    number = _num(value)
    if number is None:
        return ""
    whole = int(Decimal(str(number)).quantize(Decimal(1), rounding=ROUND_HALF_UP))
    return next((name for floor, name in _SCORE_BANDS if whole >= floor), "low")


def _quality_words(o: Mapping[str, Any]) -> str:
    """The false-positive and automation rates of a posture reading in words, not
    figures (the key-figure block shows the figures, T15)."""
    quality = o.get("quality") if isinstance(o.get("quality"), Mapping) else {}
    fp, auto = _num(quality.get("false_positive_rate")), _num(quality.get("automation_rate"))
    if quality and fp is None and auto is None:
        return "False-positive and automation rates are not measured: no case in this window has a closing verdict yet."
    parts = []
    if fp is not None:
        parts.append("most closed cases were false positives" if fp >= 0.5 else
                     "few closed cases were false positives" if fp < 0.2 else "some closed cases were false positives")
    if auto is not None:
        parts.append("the AI closed almost all of them" if auto >= 0.8 else
                     "the AI closed most of them" if auto >= 0.5 else "analysts closed most of them")
    if not parts:
        return ""
    within = _in(_window(o))
    return f"{within[:1].upper()}{within[1:]}, {_join(parts)}."


#: The posture figures a question can ask for, by name (T15 focus).
_POSTURE_FOCUS: tuple[tuple[str, str], ...] = (
    (r"\b(?:automation|auto[- ]?clos\w*) rates?\b", "automation"),
    (r"\b(?:fp|false[- ]positive) rates?\b|\bfp\b", "fp"),
    (r"\bsla\b", "sla"),
    (r"\bmtt[adr]\b|\bresponse times?\b", "timing"),
)


def _posture_focus(lowered: str) -> list[str]:
    """The posture figures the question names, in the order it names them, at most
    two (T15: the prose names at most two of the block's figures)."""
    found = []
    for pattern, name in _POSTURE_FOCUS:
        match = re.search(pattern, lowered)
        if match:
            found.append((match.start(), name))
    return [name for _start, name in sorted(found)][:2]


def _say_posture(r: Result, *, focus: str | Sequence[str] | None = None) -> list[str]:
    """The posture takeaway (Round 13 T15). The posture figures are in the key-figure
    block beside the prose, so the prose names at most two of them: the risk index over
    the open queue, or the figures the question asks about (``focus``: up to two of
    "fp", "automation", "sla" and "timing", in the question's order), and says in words
    what the rest mean."""
    focuses = [focus] if isinstance(focus, str) else list(focus or [])[:2]
    if len(focuses) > 1:
        out = [line for name in focuses for line in _say_posture(r, focus=name)[:1]]
        band = _band(r.obs.get("active_risk_index"))
        if band:
            out.append(f"Risk across the open queue is {band} on the Active Risk Index.")
        out.append(_completeness(r.obs))
        return [line for line in out if line]
    focus = focuses[0] if focuses else None
    o = r.obs
    window = _window(o)
    within = _in(window)
    severity = o.get("severity_counts") if isinstance(o.get("severity_counts"), Mapping) else {}
    critical = _num(severity.get("critical"))
    quality = o.get("quality") if isinstance(o.get("quality"), Mapping) else {}
    fp, auto = _num(quality.get("false_positive_rate")), _num(quality.get("automation_rate"))
    sla = o.get("sla") if isinstance(o.get("sla"), Mapping) else {}
    sla_measured = bool(sla.get("enabled")) and bool(_num(sla.get("evaluated")))
    band = _band(o.get("active_risk_index"))
    out: list[str] = []
    if focus == "automation":
        out.append(f"Automation rate **{_pct(auto, ratio=True)}** {within}: that share of the closed cases was "
                   "closed automatically, without an analyst." if auto is not None else
                   f"Automation rate: not measured {within}, where no case has been closed yet.")
    elif focus == "fp":
        out.append(f"False-positive rate **{_pct(fp, ratio=True)}** {within}: that share of the cases closed "
                   "with a verdict were false positives." if fp is not None else
                   f"False-positive rate: not measured {within}, where no case has a closing verdict yet.")
    elif focus == "sla":
        out.append(f"SLA attainment **{_pct(sla.get('attainment_pct'))}** {within}, with "
                   f"{_plural(sla.get('response_breached'), 'response breach', 'response breaches')} and "
                   f"{_plural(sla.get('resolve_breached'), 'resolution breach', 'resolution breaches')}."
                   if sla_measured else
                   f"SLA attainment: not evaluated {within}, " + ("where no case has an SLA outcome yet."
                                                                  if sla.get("enabled")
                                                                  else "because no SLA policy is enabled."))
    elif focus == "timing":
        timing = []
        lifecycle = o.get("lifecycle_minutes") if isinstance(o.get("lifecycle_minutes"), Mapping) else {}
        for key, name in (("mttd_minutes", "MTTD"), ("mtta_minutes", "MTTA"), ("mttr_minutes", "MTTR")):
            metric = lifecycle.get(key) if isinstance(lifecycle.get(key), Mapping) else None
            if metric is None:
                continue
            if metric.get("measured") and _num(metric.get("p50")) is not None:
                timing.append(f"{name} p50 {_minutes(metric.get('p50'))}")
            else:
                timing.append(f"{name} not measured yet")
        if timing:
            out.append(f"Timing {within}: {_join(timing)}.")
    if focus is None:
        out.append(f"**Active Risk Index {_whole(o.get('active_risk_index'))}**" + (f" ({band})" if band else "")
                   + f" across the {_plural(_dig(o, 'open_now', 'count'), 'case')} open now.")
        out.append(_quality_words(o))
    elif band:
        out.append(f"Risk across the open queue is {band} on the Active Risk Index.")
    if critical:
        out.append(f"{_plural(critical, 'critical case')} {'was' if critical == 1 else 'were'} created {within}.")
    out.append(_completeness(o))
    return [line for line in out if line]


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


def _say_trends(r: Result, *, totals: bool = True) -> str:
    """The trend in one sentence: the window's new and closed totals (``totals``; a
    posture answer leaves them to its key-figure block, T15) and the peak bucket."""
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
    span = _in(_window(o))
    span = "over the " + span[len("in the "):] if span.startswith("in the ") else span
    peaks = sum(1 for v in new if v == peak)
    if peaks > 1:
        # Several buckets reached the peak: never one of them alone as "the peak" (PB5).
        recent = where if labels or peak_at != len(new) - 1 else f"in {where}"
        peak_text = f"the peak, {_plural(peak, 'new case')}, came in {peaks} {kind}s, most recently {recent}"
    else:
        peak_text = f"the peak was {where}, with {_plural(peak, 'new case')}"
    if totals:
        text = (f"Trend {span} in {kind}s: {_count(sum(measured))} new and "
                f"{_count(sum(v for v in closed if v is not None))} closed cases; {peak_text}.")
    else:
        text = f"Trend {span} in {kind}s: {peak_text}."
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
    # A withheld overall reduction (the tool's partial-coverage rule) leads with the
    # stages instead of a "not measured noise reduction" headline.
    head = f"**{_pct(overall)} noise reduction**" if _num(overall) is not None else "**Noise reduction**"
    if "ingested" in stages:
        flow = (f"{_plural(stages.get('ingested'), 'alert')} ingested became "
                f"{_plural(stages.get('clustered'), 'cluster')} and {_plural(stages.get('cases'), 'case')},")
    else:
        # The alert stages were not measured (counters warming up, or a window the
        # counters do not reach back to): never narrated as 0 alerts (G3).
        flow = f"alerts were not measured; {_plural(stages.get('cases'), 'case')} opened,"
    out = [f"{head} {_in(_window(o))}: {flow} and **{_count(stages.get('needs_human'))} needed a human**."]
    # One stage figure (T15): the Reduction figures block shows the escalated and
    # human-closed counts beside it.
    if "auto_cleared" in stages:
        out.append(f"Of the cases, the AI auto-cleared {_count(stages['auto_cleared'])}"
                   + (f" and {_count(stages['policy_closed'])} were closed by analyst policy"
                      if stages.get("policy_closed") else "") + ".")
    if _num(before) is not None:
        out.append(f"Before any human looked, volume was already down {_pct(before)}.")
    withheld = _num(overall) is None and bool(o.get("overall_reduction_withheld"))
    if o.get("alert_stages_not_measured"):
        out.append("The alert counters do not reach back to this window, so its alerts were not counted and "
                   "no overall reduction is given.")
    elif _dig(o, "counters", "incomplete"):
        out.append("The ingest counters do not span the whole window yet, so the alert count is a lower bound"
                   + (" and no overall reduction is given (alerts and cases cover different spans)." if withheld
                      else "."))
    elif withheld:
        out.append("No overall reduction is given: the case counts for this window are partial.")
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
        text += f", average risk {_score(o.get('avg_risk_score'))}"
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
            # The medians only (T15): the Response times block beside it shows the p90s.
            count = f" over {_plural(metric.get('count'), 'case')}" if _num(metric.get("count")) else ""
            parts.append(f"{name} p50 {_minutes(metric.get('p50'))}{count}")
        else:
            parts.append(f"{name} not measured yet")
    return f"Response times {_in(_window(o))}: {_join(parts)}." if parts else ""


def _say_auto_close(r: Result) -> str:
    o = r.obs
    current = o.get("current") if isinstance(o.get("current"), Mapping) else {}
    # Two of the health figures (T15): the rate and the cases routed to a human.
    text = (f"Auto-close {_in(_window(o))}: {_pct(current.get('rate'), ratio=True)} of the decided cases closed "
            f"automatically, and {_count(current.get('routed_to_human'))} "
            f"{'was' if _num(current.get('routed_to_human')) == 1 else 'were'} routed to a human.")
    if o.get("status") == "insufficient_evidence":
        text += " There is not enough history in the previous window to compare against yet."
    elif o.get("needs_attention"):
        text += " The rate moved enough versus the previous window to need attention."
    return text


def _say_mitre_coverage(r: Result) -> str:
    o = r.obs
    top = [t for t in o.get("top_techniques") or [] if isinstance(t, Mapping)][:3]
    # Two of the coverage figures (T15): techniques seen and the share of the corpus.
    text = (f"Cases cover {_plural(o.get('covered_techniques'), 'ATT&CK technique')}, "
            f"{_pct(o.get('coverage_pct'))} of the bundled corpus")
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
    # Two of the AI cost figures (T15): the spend and the calls; the block shows tokens.
    out = [f"**AI spend {_in(_window(o))}: {_usd(o.get('total_cost_usd'))}{simulated}** across "
           f"{_plural(o.get('calls'), 'model call')}."]
    for key, name in (("by_role", "By role"), ("by_model", "By model"), ("by_surface", "By surface")):
        rows = [x for x in o.get(key) or [] if isinstance(x, Mapping)][:4]
        if rows:
            out.append(f"{name}: " + _join([f"{_code(x.get('key'))} {_usd(x.get('cost'))} "
                                            f"({_plural(x.get('calls'), 'call')})" for x in rows]) + ".")
    daily = _dig(o, "budget", "daily")
    if _dig(o, "budget", "enabled") and isinstance(daily, Mapping) and _num(daily.get("cap")):
        out.append(f"Today's budget is {_pct(daily.get('fraction'), ratio=True)} used of {_usd(daily.get('cap'))} "
                   f"({display_text(daily.get('band'), 20) or 'ok'}). "
                   "The daily budget limits automatic investigations (at the limit they route to Needs human); "
                   "chat answers are not blocked by it.")
    return out


def _say_shift(r: Result, *, with_window: bool = True) -> list[str]:
    o = r.obs
    head = o.get("headline") if isinstance(o.get("headline"), Mapping) else {}
    # ``needs_human_verdict`` counts the open cases whose VERDICT is Needs human, the
    # badge the Needs attention list shows (Round 13 close), never the legacy status.
    when = f" at the end of the {_window(o)}" if with_window else ""
    out = [f"**{_plural(head.get('open'), 'open case')}**{when}: "
           f"{_count(head.get('escalated'))} escalated, {_count(head.get('needs_human_verdict'))} marked Needs "
           f"human, {_count(head.get('unassigned'))} unassigned and {_count(head.get('sla_breached'))} past SLA."]
    changes = o.get("changes_vs_prior_window") if isinstance(o.get("changes_vs_prior_window"), Mapping) else {}
    moved = []
    for key, name in (("open", "open"), ("escalated", "escalated"), ("sla_breached", "past SLA")):
        delta = _num(_dig(changes, key, "delta"))
        if delta:
            moved.append(f"{name} {'+' if delta > 0 else '−'}{_count(abs(delta))}")
    if moved:
        out.append(f"Versus the previous window: {_join(moved)}.")
    return out


def _shift_takeaway(r: Result) -> str:
    """The shift headline in one sentence with two of its figures (T15): the open
    cases and the most pressing of past SLA, escalated or unassigned."""
    head = r.obs.get("headline") if isinstance(r.obs.get("headline"), Mapping) else {}
    text = f"**{_plural(head.get('open'), 'open case')}**"
    for key, words in (("sla_breached", "past SLA"), ("escalated", "escalated"), ("unassigned", "unassigned")):
        if _num(head.get(key)):
            return f"{text}, {_count(head.get(key))} of them {words}."
    return text + ", none past SLA, escalated or unassigned." if _num(head.get("open")) else text + "."


def _named_with_more(names: Sequence[str], total: Any, limit: int) -> tuple[list[str], int]:
    """``(names to say, how many more)``: every name when there are at most ``limit``,
    else the first ``limit - 1`` and the count of the rest, so a list is never cut
    without saying so (Round 13 close). ``total`` is how many there are (the lookup's
    count, which can exceed the names it lists), else ``len(names)``."""
    count = max(len(names), int(_num(total) or 0))
    if count <= limit:
        return list(names), 0
    keep = list(names[:max(1, limit - 1)])
    return keep, count - len(keep)


def _campaign_entities(c: Mapping[str, Any], limit: int) -> list[str]:
    """A campaign's shared entities in words, "K more shared entities" last when it has
    more than ``limit`` (for :func:`_join`). The tail names its noun: a bare "6 more"
    after "9 cases sharing IP …" read as six more cases (Round 13 close BF)."""
    names = [_entity_phrase(e) for e in c.get("entities") or [] if isinstance(e, str)]
    shown, more = _named_with_more(names, c.get("entity_count"), limit)
    return shown + ([_plural(more, "more shared entity", "more shared entities")] if more else [])


def _more_techniques(more: int) -> str:
    """The tail of a cut technique list, its noun named: "3 more techniques"."""
    return _plural(more, "more technique")


def _campaign_techniques(c: Mapping[str, Any], limit: int = 4) -> str:
    """"ATT&CK T1021, T1048, T1078, T1566": every technique of a campaign up to
    ``limit``, else the first ones and "and K more techniques" (a fourth one was
    dropped without a word, Round 13 close); "" when it has none."""
    ids = [display_text(m, 12) for m in c.get("mitre") or [] if isinstance(m, str)]
    shown, more = _named_with_more(ids, c.get("mitre_count"), limit)
    if not shown:
        return ""
    # The ids read as the table cell lists them ("T1021, T1048, T1078, T1566").
    return "ATT&CK " + ", ".join(shown) + (f" and {_more_techniques(more)}" if more else "")


#: How many of a case's ATT&CK techniques the prose names before "and K more
#: techniques" (the case's ATT&CK block lists every one).
_CASE_TECHNIQUES_SAID = 4


def _case_techniques(mitre: Sequence[Mapping[str, Any]], *, tactic: bool) -> str:
    """A case's ATT&CK techniques in words ("T1566 Phishing (Initial Access)"): every one
    up to :data:`_CASE_TECHNIQUES_SAID`, else the first ones and "and K more techniques",
    never a silent cut beside a block that lists them all (Round 13 close BF)."""
    named = [f"{display_text(m.get('id'), 12)} {display_text(m.get('name'), 60)}".strip()
             + (f" ({display_text(m.get('tactic'), 40)})" if tactic and m.get("tactic") else "")
             for m in mitre]
    shown, more = _named_with_more(named, None, _CASE_TECHNIQUES_SAID)
    return _join(shown + ([_more_techniques(more)] if more else []))


def _say_campaigns(r: Result, rows: Sequence[Mapping[str, Any]] | None = None) -> str:
    """The campaigns a lookup listed (or ``rows``, a subset of them: their count then
    leads, without the status filter)."""
    o = r.obs
    subset = rows is not None
    rows = list(rows) if rows is not None else [c for c in o.get("campaigns") or [] if isinstance(c, Mapping)]
    text = f"**{_plural(len(rows) if subset else o.get('total'), 'campaign')}**"
    if o.get("status_filter") and not subset:
        text += f" ({display_text(o.get('status_filter'), 20)})"
    if not rows:
        return text + "."
    parts = []
    for c in rows[:3]:
        # Named by its display name, else by what ties it together (the shared
        # entity): the content-hash id stays in the table (browser-QA D6). The name
        # is stored text, so it is inline code like a case id (exact, lookalikes visible).
        name = _code(c.get("name")) if isinstance(c.get("name"), str) and c.get("name").strip() else ""
        what = _plural(c.get("case_count"), "case")
        entities = _campaign_entities(c, 2)
        if entities:
            # Said whole: ``list_campaigns`` already bounds a value (operator ask 3).
            what += " sharing " + _join(entities)
        bits = []
        if c.get("severity"):
            bits.append(display_text(c.get("severity"), 20))
        techniques = _campaign_techniques(c)
        if techniques:
            bits.append(techniques)
        detail = f" ({'; '.join(bits)})" if bits else ""
        parts.append(f"{name} with {what}{detail}" if name else f"{what}{detail}")
    return f"{text}: {_join(parts)}."


def _say_lookup(r: Result) -> str:
    o = r.obs
    value = _code(o.get("indicator"))
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
    """A verdict before a noun: "true-positive", "false-positive", and "needs human" as
    the case badge names it (never the hyphenated "needs-human")."""
    word = _verdict_word(value)
    return word if word == "needs human" else word.replace(" ", "-")


def _case_facts(case: Mapping[str, Any]) -> str:
    """The case's verdict as a predicate with its verb: "is a true positive at 99%
    confidence, risk 88/100, severity critical", "needs human review at 88% confidence,
    …" (a routing verdict, not a kind of case), "has no verdict yet, …". Risk and
    severity are separate axes, so each is named: a bare "risk 7 (critical)" reads as a
    critical risk band beside a LOW risk gauge."""
    verdict = _verdict_word(case.get("verdict"))
    upper = str(case.get("verdict") or "").upper()
    if not verdict:
        text = "has no verdict yet"
    elif upper in ("TRUE_POSITIVE", "FALSE_POSITIVE"):
        text = f"is a {verdict}"
    elif upper == "NEEDS_HUMAN":
        text = "needs human review"
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
        head = (_case_head(case, start=True)
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
        facts.append(("rule " if len(rules) == 1 else "rules ") + _join([_code(x) for x in rules]))
    if case.get("source"):
        facts.append(f"source {_code(case.get('source'))}")
    if _num(case.get("member_events")) is not None:
        facts.append(_plural(case.get("member_events"), "member event"))
    if facts:
        out.append(f"It covers {_join(facts)}.")
    evidence = [e for e in o.get("evidence") or [] if isinstance(e, Mapping) and e.get("summary")]
    if evidence:
        out.append(f"Recorded evidence: {_plain(evidence[0].get('summary'), _NARRATED_CHARS)}")
    mitre = [m for m in o.get("mitre") or [] if isinstance(m, Mapping) and m.get("id")]
    if mitre:
        out.append("ATT&CK: " + _case_techniques(mitre, tactic=True) + ".")
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
        return "a case that needs human review never auto-closes (enforced in code)"
    if not isinstance(row, Mapping):
        return ""
    word = _verdict_word(verdict)
    if not row.get("auto_close_enabled"):
        return f"{word.replace(' ', '-')} auto-close is turned off in the policy"
    # The thresholds themselves are in the decision inputs block beside the prose, which
    # already names the case's confidence and risk: the reason says which side of each
    # bar the case is on, without restating the bars (T15: at most two of its figures).
    reasons = []
    confidence, minimum = _num(what.get("confidence")), _num(row.get("min_confidence"))
    if confidence is not None and minimum is not None and confidence < minimum:
        reasons.append("its confidence is below the policy's minimum")
    risk, ceiling = _num(what.get("risk_score")), _num(row.get("max_risk_score"))
    if risk is not None and ceiling is not None and risk > ceiling:
        reasons.append("its risk is above the policy's ceiling")
    if reasons:
        return _join(reasons)
    return (f"it meets the policy's {word.replace(' ', '-')} bar for both confidence and risk"
            if minimum is not None and ceiling is not None else "")


def _say_decision(r: Result) -> str:
    o = r.obs
    what = o.get("what_if") if isinstance(o.get("what_if"), Mapping) else {}
    if not what:
        return ""
    status = display_text(what.get("status"), 30)
    verb, trail = _OUTCOME_WORDS.get(status, ("gives", f" the status {status.replace('_', ' ')}"))
    inputs = (f"a {_verdict_adjective(what.get('verdict'))} verdict at "
              f"{_pct(_num(what.get('confidence')), ratio=True)} confidence and risk {_count(what.get('risk_score'))}")
    reason = _policy_reason(o, what)
    recorded = o.get("recorded") if isinstance(o.get("recorded"), Mapping) else {}
    by = recorded.get("decision_by")
    rec_status = str(recorded.get("status") or "")
    who = _RECORDERS.get(by, display_text(by, 30).replace("_", " ")) if isinstance(by, str) and by else ""
    if who and by != what.get("decision_by") and rec_status in _TERMINAL_STATUSES and status in _WOULD_WORDS:
        # The case was closed one way and today's policy would route it another (the
        # policy changed since, or a person closed it): both, reconciled in one sentence.
        return (f"It was {rec_status} by {who}; under today's policy a case like it ({inputs}) would "
                f"{_WOULD_WORDS[status]}" + (f", because {reason}." if reason else "."))
    text = f"The deterministic auto-close policy {verb} a case with {inputs}{trail}"
    text += f", because {reason}." if reason else "."
    if who and by != what.get("decision_by"):
        text += f" Its current status was set by {who}."
    return text


#: Who set a case's recorded status, by ``Case.decision_by``, as a sentence names them.
_RECORDERS = {"agent": "the AI agent", "system": "deterministic routing", "analyst": "an analyst",
              "analyst_policy": "an analyst's declared-benign rule", "automation": "an automation rule"}
#: What today's policy would do with a case, for the outcomes that do not close it.
_WOULD_WORDS = {"needs_human": "go to a human", "escalated": "be escalated", "open": "stay open"}


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
        out.append(f"- {_code(s.get('name'))} ({display_text(s.get('type'), 20)}, "
                   f"{display_text(s.get('kind'), 10)}): {', '.join(state)}")
    return out


def _say_audit(r: Result) -> str:
    o = r.obs
    by_type = o.get("by_action_type") if isinstance(o.get("by_action_type"), Mapping) else {}
    parts = [f"{_count(n)} {display_text(k, 30).replace('_', ' ')}"
             for k, n in sorted(by_type.items(), key=lambda kv: (-(_num(kv[1]) or 0), kv[0]))[:4]]
    if r.input.get("action_type") == "status":
        # The "case status changes" chip: one action type, so no breakdown by type.
        return f"**{_plural(o.get('matched'), 'case status change')}** {_in(_window(o))}."
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
    "cost_compare": ("Compare AI spend this month with last month", ("cost_usage",)),
    "cost_month": ("How much did we spend on AI by month?", ("cost_usage",)),
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
    "cost": ("cost_compare", "cost_month", "posture", "noise"),
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
    "respond": ("case", "access", "pivot"),
    "out_of_scope": ("posture", "case", "shift"),
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
    #: Round 13 (SPEC-chat T6): the conversation's title, on its first answer only.
    title: str = ""


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
        # The figure the question names leads (T15: the prose names at most two of
        # the key figures the block beside it shows); else the index over the queue.
        body.extend(_say_posture(post, focus=_posture_focus(ask.lowered)))
    if trend:
        sentence = _say_trends(trend, totals=post is None)
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


def _sla_first(shift: Result | None) -> tuple[int, list[Mapping[str, Any]]]:
    """``(total past SLA, the most overdue cases the brief names)``: the headline's total
    (the snapshot lists at most five of them, most overdue first) and at most three of
    them, each as its attention-queue row when it has one (that row says what the case is
    about). The step and the lead name the same cases, so the brief has one starting
    point (polish round PB4)."""
    o = shift.obs if shift else {}
    head = o.get("headline") if isinstance(o.get("headline"), Mapping) else {}
    breached = [b for b in _dig(o, "sla", "breached") or [] if isinstance(b, Mapping)]
    total = int(max(_num(head.get("sla_breached")) or _num(_dig(o, "sla", "totals", "breached")) or 0,
                    len(breached)))
    named = {str(a.get("case_id")): a for a in o.get("attention") or [] if isinstance(a, Mapping)}
    return total, [named.get(str(b.get("case_id")), b) for b in breached[:3]] if total else []


def _overdue_ties(shift: Result | None) -> list[Mapping[str, Any]]:
    """The cases past SLA overdue by exactly as long as the most overdue one (whole
    minutes), which the brief would otherwise present as second (PB5)."""
    breached = [b for b in _dig(shift.obs if shift else {}, "sla", "breached") or [] if isinstance(b, Mapping)]
    minutes = [_num(b.get("overdue_minutes")) for b in breached]
    if len(breached) < 2 or minutes[0] is None:
        return []
    named = {str(a.get("case_id")): a for a in (shift.obs.get("attention") if shift else None) or []
             if isinstance(a, Mapping)}
    return [named.get(str(b.get("case_id")), b) for b, m in zip(breached[1:], minutes[1:])
            if m is not None and round_half_up(m) == round_half_up(minutes[0])]


def _shift_steps(shift: Result | None, post: Result | None, camps: Result | None) -> list[str]:
    steps: list[str] = []
    o = shift.obs if shift else {}
    head = o.get("headline") if isinstance(o.get("headline"), Mapping) else {}
    # The total past SLA is stated once, then exactly the cases named (PB3).
    total, shown = _sla_first(shift)
    if total:
        names = _join([_case_head(row, bold=False) for row in shown])
        if not shown:
            steps.append(f"Work the {_plural(total, 'case')} past SLA first.")
        elif len(shown) == total:
            steps.append(f"Work the {_plural(total, 'case')} past SLA first: {names}.")
        else:
            most = "the most overdue" if len(shown) == 1 else f"the {_count(len(shown))} most overdue"
            steps.append(f"Work the {_plural(total, 'case')} past SLA first, starting with {most}: {names}.")
    if _num(head.get("needs_human_verdict")):
        steps.append(f"Give a verdict on the {_plural(head.get('needs_human_verdict'), 'open case')} marked "
                     "Needs human.")
    if _num(head.get("escalated")):
        steps.append(f"Confirm an owner and containment for the {_plural(head.get('escalated'), 'escalated case')}.")
    if _num(head.get("unassigned")):
        steps.append(f"Assign the {_plural(head.get('unassigned'), 'unassigned open case')}.")
    if camps and _num(camps.obs.get("total")):
        total = camps.obs.get("total")
        steps.append(f"Track the {_plural(total, 'open campaign')} that {'links' if _num(total) == 1 else 'link'} "
                     "related cases.")
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
            steps.append(f"Review the {_plural(head.get('open'), 'open case')}; none is past SLA, escalated, marked "
                         "Needs human or unassigned.")
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
    # The handoff card (SPEC §3.4 shift_handoff): open work first, then what changed.
    handoff = ask.starter == "shift_handoff"
    body: list[str] = []
    attention = [a for a in (shift.obs.get("attention") if shift else None) or [] if isinstance(a, Mapping)]
    if shift:
        # The brief's lead names the window once and two of the headline figures (the
        # Shift headline block beside it shows them all, T15).
        lines = _say_shift(shift, with_window=False)
        head = "Handoff for the next shift" if handoff else "Shift brief"
        body.append(f"**{head}, {window}.** " + _shift_takeaway(shift))
        body.extend(lines[1:])
        if attention:
            body.append("Needs attention first:")
            body.extend(f"- {_case_line(a)}" for a in attention[:3])
    posture_line = ""
    if post:
        p = post.obs
        band = _band(p.get("active_risk_index"))
        posture_line = (f"Posture: Active Risk Index {_whole(p.get('active_risk_index'))}"
                        + (f" ({band})" if band else "") + ".")
        body.append(posture_line)
    if camps:
        body.append(_say_campaigns(camps))
    steps = _shift_steps(shift, post, camps)
    if not view.case_scoped:
        # The brief holds the detail (headline, open work, campaigns, metrics, next
        # steps); the prose is its 1–3 sentence lead (browser-QA D5). A Case Manager
        # turn keeps the full narration: its brief is unwrapped into plain blocks.
        lead = [body[0] if shift else posture_line]
        # One starting point (polish round PB4): with cases past SLA the Next steps
        # start with the most overdue, so the lead does too; when the snapshot names
        # none of them the lead only says what tops the attention queue.
        total, overdue = _sla_first(shift)
        first = overdue[0] if overdue else attention[0] if attention else None
        if first is not None:
            why = []
            if first.get("status"):
                why.append(display_text(first.get("status"), 20).replace("_", " "))
            if _num(first.get("risk_score")) is not None:
                why.append(f"risk {_count(first.get('risk_score'))}")
            said = _case_head(first, bold=False) + (f", {', '.join(why)}" if why else "")
            if overdue:
                tied = _overdue_ties(shift) if total > 1 else []
                past = (f"tied with {_peers([_case_ref(t) for t in tied])} as the most overdue of the "
                        f"{_plural(total, 'case')} past SLA" if tied
                        else f"the most overdue of the {_plural(total, 'case')} past SLA" if total > 1
                        else "the one case past SLA")
                lead.append(f"Start with {said}: {past}.")
            else:
                lead.append(f"{'Top of the attention queue:' if total else 'Start with'} {said}.")
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
    if handoff:
        summary_section["heading"] = "What changed"
        sections = [sections[1], sections[0], *sections[2:]]
    sections = [s for s in sections if s["items"]]
    envelope = {"type": "report", "title": "Shift handoff" if handoff else "Shift brief", "template": "shift",
                "sections": sections}
    if window.strip():
        envelope["subtitle"] = f"{'Handoff' if handoff else 'Last shift'} · {window}"
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
#: What a report without a named template is about, by intent: its title names that
#: subject and the window ("Cases report, September 2026"), so the Reports library
#: never fills with identical "Report" names.
_INTENT_SUBJECTS = {
    "cases": "Cases", "breakdown": "Cases", "summary": "SOC summary", "trend": "Trend", "compare": "Comparison",
    "top": "Top {field}", "logs": "Log search", "log_count": "Log counts", "cost": "AI cost", "posture": "Posture",
    "noise": "Noise reduction", "metric": "SOC metrics", "tp": "True positives", "brute": "Brute force",
    "mitre": "ATT&CK", "audit": "Audit trail", "deep": "Investigation", "case": "Case", "hunt": "IOC",
    "pivot": "Hunt", "sources": "Source health", "campaigns": "Campaigns", "knowledge": "Knowledge",
    "automation": "Automation", "rate": "Detection rates", "entity_cases": "Cases by entity",
}


def _template_subject(view: PromptView, ask: Ask) -> str:
    """What a named-template report is about, for its title: the indicator or case id
    the analyst typed, else a case id a lookup returned, else the hunt's topic (engine
    words). Never a log-derived value (an entity a lookup returned)."""
    case_id = ask.case_id or ""
    if not case_id:
        got = view.ok("get_case")
        found = _dig(got.obs, "case", "case_id") if got is not None else None
        case_id = found if isinstance(found, str) else ""
    if ask.report == "ioc" and ask.indicator:
        return display_text(ask.indicator[0], 80)
    if ask.report == "investigation":
        return display_text(case_id, 60)
    if ask.report == "hunt":
        if ask.keyword and ask.topic:
            return display_text(ask.topic, 60)
        return display_text(case_id, 60)
    return ""


def _report_title(view: PromptView, ask: Ask) -> str:
    """A wrapped report's title: the named template's with its subject ("IOC report:
    203.0.113.42", "Investigation report: case-…") or its period ("Posture report,
    September 2026"), else the intent's subject and window."""
    if ask.report and ask.report != "custom" and ask.report in _TEMPLATE_TITLES:
        base = _TEMPLATE_TITLES[ask.report]
        subject = _template_subject(view, ask)
        if subject:
            return f"{base}: {subject}"[:120]
        window = (_report_window(view, ask) or "").split(" (")[0].strip()
        if ask.report == "posture" and window.lower().startswith("all time"):
            return "Lifetime posture report"
        return (f"{base}, {window}" if window else base)[:120]
    subject = _INTENT_SUBJECTS.get(ask.intent, "SOC")
    if "{field}" in subject:
        subject = subject.format(field=_plural_noun(_FIELD_LABEL.get(ask.field or "host", ask.field or "host")))
    window = (_report_window(view, ask) or "").split(" (")[0].strip()
    if ask.intent in ("cases", "breakdown"):
        # "Open cases report", "Escalated cases report, this week".
        noun = _case_noun(_status_filters(ask), "case")
        subject = _plural_noun(noun)[:1].upper() + _plural_noun(noun)[1:]
        if noun == "open case" and window.startswith("all time"):
            window = ""
        if _volume_and_verdict(ask.lowered):
            # Round 13 T37: the report covers both, and its title says so.
            subject = ("Case volume and true positives" if re.search(r"\btrue[- ]positives?\b", ask.lowered)
                       and not re.search(r"\bfalse[- ]positives?\b", ask.lowered)
                       else "Case volume and false positives")
    return (f"{subject} report, {window}" if window else f"{subject} report")[:120]
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
    return _figure_steps(view, ask)


def _group_counts(r: Result, field: str) -> dict[str, float]:
    """A one-field ``case_stats`` breakdown as ``{lowered label: count}``."""
    out: dict[str, float] = {}
    for g in _stats_groups(r.obs):
        key = g.get("key") if isinstance(g.get("key"), Mapping) else {}
        if set(key) == {field} and g.get("bucket") is None:
            label = str(key[field] or "").strip().lower().replace("_", " ")
            out[label] = out.get(label, 0) + (_num(_dig(g, "metrics", "count")) or 0)
    return out


def _figure_steps(view: PromptView, ask: Ask) -> list[str]:
    """Next steps for a report drawn from its own figures (Round 13 T37): the cases
    waiting for a person, the false-positive share, the critical cases, the busiest
    period and the top rule's share, each with its number. Value-free: a step names
    counts, verdicts, severities and calendar labels, never a log or case value."""
    steps: list[str] = []
    stats = [r for r in view.results() if r.ok and r.tool == "case_stats" and not _is_clock(r)
             and not _is_anchor_call(r)]
    total = next((_num(_dig(r.obs, "totals", "count")) or _num(r.obs.get("total")) for r in stats), None)
    for r in stats:
        verdicts = _group_counts(r, "verdict")
        if verdicts:
            whole = sum(verdicts.values())
            nh, fp, tp = (verdicts.get(v, 0) for v in ("needs human", "false positive", "true positive"))
            if nh:
                steps.append(f"Decide the {_plural(nh, 'case')} still waiting for a person (Needs human).")
            if fp and whole and fp / whole >= 0.5:
                steps.append(f"Review the rules behind the {_plural(fp, 'false positive')} "
                             f"({_pct(100 * fp / whole)} of {_plural(whole, 'case')}) for tuning.")
            if tp:
                steps.append(f"Confirm containment for the {_plural(tp, 'true positive')}.")
        severities = _group_counts(r, "severity")
        if severities.get("critical"):
            steps.append(f"Work the {_plural(severities['critical'], 'critical case')} first.")
        rules = _group_counts(r, "rule")
        if rules and total and not any(s.startswith("Review the rules behind") for s in steps):
            top = max(rules.values())
            tops = sum(1 for n in rules.values() if n == top)
            if top / total >= 0.25:
                # Rules tied at the top are all "the top" (PB5).
                steps.append(f"Review the top rule, which created {_count(top)} of the {_plural(total, 'case')}."
                             if tops == 1 else
                             f"Review the {_count(tops)} rules tied at the top, which created {_count(top)} of the "
                             f"{_plural(total, 'case')} each.")
        if r.obs.get("bucket") and not r.input.get("group_by"):
            counts = [(str(g.get("bucket")), _num(_dig(g, "metrics", "count")) or 0) for g in _stats_groups(r.obs)
                      if g.get("bucket") is not None and not g.get("key")]
            if len(counts) > 1:
                label, n = max(counts, key=lambda kv: kv[1])
                busiest = [lbl for lbl in _top_ties(counts) if _BUCKET_DATE_RE.match(lbl)]
                unit = r.obs.get("bucket")
                if n and _BUCKET_DATE_RE.match(label) and len(busiest) > 1:
                    steps.append(f"Check what drove {_peers(busiest)}, the busiest {unit}s with "
                                 f"{_plural(n, 'case')} each.")
                elif n and _BUCKET_DATE_RE.match(label):
                    steps.append(f"Check what drove {label}, the busiest {unit} with "
                                 f"{_plural(n, 'case')}.")
    for r in view.results():
        if r.ok and r.tool == "search_cases":
            open_rows = [c for c in r.obs.get("cases") or [] if isinstance(c, Mapping)
                         and str(c.get("status") or "") in _OPEN_STATUS_WORDS and not c.get("assignee")]
            if open_rows:
                steps.append(f"Assign an owner to the {_plural(len(open_rows), 'open case')} listed without one.")
            break
    steps = list(dict.fromkeys(steps))[:4]
    if steps:
        return steps
    if total == 0:
        return ["No case matched: widen the window or remove a filter, then re-run the report."]
    if total:
        return [f"Re-run this report for the previous period and compare it with these {_plural(total, 'case')}."]
    return ["Re-run this report at the next handoff to compare the figures."]


_BUCKET_DATE_RE = re.compile(r"^(?:\d{1,2} )?[A-Z][a-z]{2} \d{4}$|^(?:Q[1-4]|W\d{1,2}) \d{4}$|^\d{4}$")
_OPEN_STATUS_WORDS = frozenset({"new", "open", "investigating", "escalated", "on_hold", "needs_human"})


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


def _unwrap_report(final: Final, *, asked: bool = True) -> Final:
    """A case-scoped final keeps the envelope's chart and list leaves as ordinary
    blocks, drops the envelope and its 'ready to add' sentence, and, when the analyst
    asked for a report (``asked``), says where a report can be built instead."""
    leaves: list[dict[str, Any]] = []
    for block in final.blocks:
        if block.get("type") == "report":
            for section in block.get("sections") or []:
                leaves.extend(i for i in section.get("items") or [] if isinstance(i, dict) and "ref" in i)
        else:
            leaves.append(block)
    final.blocks = leaves[:12]
    final.closing = ""
    if asked:
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
    # Periods that spent the same as the most, as the answer writes it ($0.0027 and
    # $0.0027 are a tie whatever their raw values), are all named (PB5, PB6).
    shown = _usd(values[peak])
    tops = [labels[i] for i, v in enumerate(values) if v is not None and _usd(v) == shown]
    most = (f"the most was spent in {labels[peak]} ({shown})" if len(tops) == 1
            else f"the most was spent in {_peers(tops, limit=4)} ({shown} each)")
    return f"By {unit}: {most}; {sum(1 for v in values if v)} of {_plural(len(values), unit)} had any spend."


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
        # The opening sentence named the window with its dates ("AI spend in the last
        # 90 days (since 15 Jul 2026)"): the rows name it plainly, and only the previous
        # period keeps its dates, on its first mention.
        stated = (comp.get("subject"),) if _window(cost.obs, "") else ()
        body[1:1] = ["Compared with the previous period:",
                     *_say_comparison(comp, limit=2, bullets=True, stated=stated)]
    skip = {"cost_compare"} if comp else set()
    if cost.input.get("bucket") == "month":
        skip.add("cost_month")
    return Final(body=body, blocks=_keep(
        _block_titled(cost, "comparison", view="kpi_group", title="Change versus the previous period"),
        _block(cost, "kpis", view="kpi_group", title="AI cost"),
        # cost_usage has no per-role time series, so §5.5's "stacked bar by role" is
        # spend over time (one series: plain bars) beside the by-role breakdown.
        _block(cost, "series", view="bar", title="AI spend over time"),
        # The tool titles each breakdown by what it groups (role, model or surface).
        _block(cost, "categories", view=_first_view(cost, "categories", ("donut", "hbar"))),
        _block(cost, "categories", nth=2, view="hbar"),
    ), follow_ups=_follow_ups(view, "cost", charts=True, skip=skip))


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
        lines = _say_comparison(comp, limit=2, with_note=False, bullets=True)
        if lines:
            body.append("Compared with the previous period:")
            body.extend(lines)
    tops = _comparison_of(stats.obs, "top_values")
    if tops:
        lines = _say_comparison(tops, limit=5, plain_labels=False, bullets=True)
        if lines:
            body.append(f"By {label}:")
            body.extend(lines)
    if intent == "regroup":
        body.insert(0, f"Re-ran the earlier lookup grouped by {label} (same filters).")
    # One block per figure set: the chart's view switcher already offers the table.
    return Final(body=body, blocks=_keep(
        _block(stats, "categories", view="hbar", title=f"Top {_plural_noun(label)} ({window.split(' (')[0]})"),
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


def _brute_field(ask: Ask) -> str:
    """The field failed sign-ins are ranked by: the one the question names ("by user",
    "per host"), else the source IP."""
    named = _group_field(ask.lowered)
    return named if named in ("ip", "user", "host") else "ip"


def _final_brute(view: PromptView, ask: Ask) -> Final | None:
    stats, cases = view.ok("log_stats"), view.ok("search_cases")
    by = _brute_field(ask)
    label = _FIELD_LABEL.get(by, by)
    if stats is None and cases is None:
        return None
    # "Show failed logins by source IP": the log figures the question asks for lead;
    # "Any brute force?": the confirmed cases lead.
    logs_first = bool(stats) and bool(re.search(
        r"\b(?:log ?ins?|logons?|sign[- ]?ins?|by (?:source )?ips?|events?|logs?)\b", ask.lowered))
    case_part: list[str] = []
    if cases:
        case_part.append(_say_search_cases(cases, noun="brute-force case"))
        case_part.extend(_case_bullets(cases))
    log_part: list[str] = []
    if stats:
        top = [t for t in _dig(stats.obs, "top", by) or [] if isinstance(t, Mapping)]
        # A text filter, not a parsed outcome field: say what was matched, not "failed sign-ins".
        log_part.append("Log events matching the text filter `fail`: " + _say_log_stats(stats, subject=""))
        peak = _num(top[0].get("count")) if top else None
        where = "below" if logs_first else "above"
        if peak is not None and peak <= 3:
            log_part.append(f"No single {label} dominates, so the logs do not show an active brute force right "
                            f"now; the cases {where} hold the confirmed activity.")
        elif peak is not None:
            log_part.append(f"{_code(top[0].get('value'))} stands out; hunt it to check its reputation and "
                            "related cases.")
    body = log_part + case_part if logs_first else case_part + log_part
    return Final(body=body, blocks=_keep(
        _block(stats, "categories", view="hbar", title=f"Events matching 'fail' by {label}"),
        _block(cases, "case_list", view="case_list", title="Brute-force cases"),
    ), follow_ups=_follow_ups(view, "brute", charts=True, field=by))


def _final_tp(view: PromptView, ask: Ask) -> Final | None:
    tps, mix = view.ok("search_cases"), view.ok("soc_metrics", "case_mix")
    if tps is None and mix is None:
        return None
    body = []
    if tps:
        body.append(_say_search_cases(tps, noun="true positive"))
        explained = _explained_cases(tps, 10) if _explains_each(ask) else []
        body.extend(explained or _case_bullets(tps))
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
    # The caller's own open cases (a "my case" starter) are said by the starter's line.
    search = view.ok("search_cases", where=lambda r: not _is_my_search(r))
    status_word = (ask.case_status or "matching").replace("_", " ")
    if got is None and decision is None:
        if search is not None and not _num(search.obs.get("count")):
            return Final(body=[f"No {status_word} case was found{_zero_where(search)}, so there is nothing to "
                               f"investigate.{_zero_hint(search)}"],
                         follow_ups=_follow_ups(view, "case"))
        return None
    case = _dig(got.obs, "case") if got else None
    case = case if isinstance(case, Mapping) else {}
    body: list[str] = []
    if case:
        # The id is the handle; what happened to which entity names the case (D6).
        lead = _case_head_as_asked(case, ask, start=True)
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
    action = _plain(_dig(case, "recommended_action"), _NARRATED_CHARS)
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
        return Final(body=[f"No {name} case was found{_zero_where(search)} to pivot from.{_zero_hint(search)}"],
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
            # Others with an indicator entity at the same risk: named, the first listed
            # is the one followed (PB5).
            rows = [c for c in (search.obs.get("cases") if search else None) or [] if isinstance(c, Mapping)
                    and (_entity_of({"case": c}) or ("", ""))[0] in _LOOKUP_KIND]
            read = next((c for c in rows if c.get("case_id") == source.get("case_id")), None)
            tied = _risk_ties(rows, read) if read is not None else []
            if tied and read is not None:
                anchor = ("The question names no indicator or known attack type, so this hunt is anchored on the "
                          f"first listed of the open cases with an indicator entity tied for the highest risk "
                          f"({_shown_risk(read)}, with {_peers([_case_ref(c) for c in tied])}),")
        name = _case_name(source, with_entity=False)
        body.append(f"{anchor} {_case_head(source, bold=False, name=name)}"
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
            body.append("The source case maps to ATT&CK " + _case_techniques(mitre, tactic=False) + ".")
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
    if lookup is None and coverage is not None and not ask.techniques:
        return Final(body=["No ATT&CK technique is recorded on your cases yet."],
                     blocks=_keep(_block(coverage, "kpis", view="kpi_group", title="ATT&CK coverage")))
    if lookup is None:
        return None
    if coverage is not None and not ask.techniques and _MITRE_IN_CASES_RE.search(ask.lowered):
        # The techniques the cases carry, most cases first, then what each one is.
        top = [t for t in coverage.obs.get("top_techniques") or [] if isinstance(t, Mapping)][:5]
        names = {display_text(t.get("id"), 12): display_text(t.get("name"), 80)
                 for t in lookup.obs.get("techniques") or [] if isinstance(t, Mapping)}
        lead = "The ATT&CK techniques seen most in your cases: " + _join([
            f"{_code(display_text(t.get('id'), 12))} {names.get(display_text(t.get('id'), 12), '')}".rstrip()
            + f" ({_plural(t.get('cases'), 'case')})" for t in top]) + "."
        return Final(body=[lead], blocks=_keep(
            _block(lookup, "mitre", view="mitre", title="ATT&CK techniques"),
            _block(coverage, "kpis", view="kpi_group", title="ATT&CK coverage"),
        ), follow_ups=_follow_ups(view, "mitre"))
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


def _final_automation(view: PromptView, ask: Ask) -> Final | None:
    """Automation status. Threshold tuning in one takeaway (T15: the Threshold tuning
    block shows its figures); approvals as the approvals starter answers them; any
    other kind from its engine summary."""
    if ask.metric == "approvals" or view.ok("automation_status", "approvals"):
        return _final_approvals(view, ask)
    tuning = view.ok("automation_status", "tuning")
    if tuning is None:
        return None
    o = tuning.obs
    observed, over = _num(o.get("rules_observed")), sum(
        1 for r in o.get("rules") or [] if isinstance(r, Mapping) and r.get("over_target"))
    recommended = _num(o.get("recommendations")) or 0
    lead = f"Threshold tuning is watching **{_plural(observed, 'rule')}**"
    lead += (f"; {_plural(over, 'rule')} {'is' if over == 1 else 'are'} over the false-positive target"
             if over else "; none is over the false-positive target") + "."
    body = [lead, "It recommends no change right now." if not recommended else
            "Its recommendations wait for review on the Approvals page."]
    if isinstance(o.get("note"), str) and "dry run" in o.get("note", ""):
        body.append("This is a dry run: nothing was applied or proposed.")
    return Final(body=body, blocks=_keep(_block(tuning, "kpis", view="kpi_group", title="Threshold tuning"),
                                         _block(tuning, "table", view="table", title="Rule noise")))


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
    timing = view.ok("soc_metrics", "timing")
    body = [_say_search_cases(cases)]
    count = _num(cases.obs.get("count")) or 0
    age = _age_lead(ask, cases.obs, count, _case_noun(_filters_of(cases.obs), "case")) if count else None
    if age:
        body[0] = age
    # The plan's own sort and length (the call echo names only its display keys).
    planned = _cases_filters(ask, view)
    oldest = planned.get("sort_field") == "created_at" and planned.get("sort_order") == "asc"
    ranked = planned.get("sort_order") if planned.get("sort_field") == "risk_score" else None
    if oldest and count:
        body.append("Oldest first: these have waited longest for someone to pick them up.")
    elif ranked and count:
        body.append("Highest risk first." if ranked == "desc" else "Lowest risk first.")
    explained = _explained_cases(cases, int(planned.get("limit") or 10)) if count and _explains_each(ask) else []
    body.extend(explained or _case_bullets(cases))
    if timing:
        said = _say_timing(timing)
        if said:
            body.append(said)
    if mix:
        body.append("Across the window: " + _say_case_mix(mix))
    title = ("Oldest open cases" if oldest else "Highest-risk cases" if ranked == "desc"
             else "Lowest-risk cases" if ranked == "asc" else "Matching cases")
    # "… with a table": the case list in its table view (the artifact offers both).
    list_view = "table" if re.search(r"\b(?:tables?|tabular)\b", ask.lowered) else "case_list"
    first = next((c for c in cases.obs.get("cases") or [] if isinstance(c, Mapping)), {})
    first_id = first.get("case_id") if isinstance(first.get("case_id"), str) else ""
    deeper = ([f"Explain case {first_id}"] if explained and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,79}", first_id)
              else [])
    return Final(body=body, blocks=_keep(
        _block(cases, "kpis", view="kpi_group", title="Key figures"),
        _block(cases, "case_list", view=list_view, title=title),
        _block(timing, "kpis", view="kpi_group", title="Response times"),
        _block(mix, "categories", view=_first_view(mix, "categories", ("donut", "hbar")), title="Cases by verdict"),
    ), follow_ups=list(dict.fromkeys([*deeper, *(_zero_suggestions(cases.obs)[1] if not count else []),
                                       *_follow_ups(view, "cases", charts=bool(mix))]))[:3])


#: "… and explain each", "explain why each one is critical", "explain the open cases":
#: the case list explains every case it shows, not three bare lines.
_EXPLAIN_EACH_RE = re.compile(r"\bexplain\w*\b|\bwhy (?:each|every|they|these|those)\b")


def _explains_each(ask: Ask) -> bool:
    return bool(_EXPLAIN_EACH_RE.search(ask.lowered))


def _explained_cases(r: Result, limit: int) -> list[str]:
    """One line per listed case (up to ``limit``, the ranking asked for): its verdict
    and confidence, risk, severity, status and rule, all from the case list itself. The
    evidence and the decision behind one case are a follow-up ("Explain case …"), so the
    closing sentence says where they are rather than presenting list facts as more."""
    cases = [c for c in r.obs.get("cases") or [] if isinstance(c, Mapping)][:max(1, min(limit, 10))]
    lines: list[str] = []
    for case in cases:
        name = _case_name(case)
        status = display_text(case.get("status"), 30).replace("_", " ")
        line = (f"- {_case_head(case, bold=False, name=name, start=True)} {_case_facts(case)}"
                + (f", status {status}" if status else ""))
        rules = [x for x in case.get("rules") or [] if isinstance(x, str)][:2]
        shown = [x for x in rules if _code(x) not in name]
        if shown:
            line += ("; rule " if len(shown) == 1 else "; rules ") + _join([_code(x) for x in shown])
        lines.append(line + ".")
    if not lines:
        return []
    return ["Case by case:", *lines,
            ("These facts come from the case list (verdict, confidence, risk, severity and status). To see a "
             "case's evidence and the decision behind it, ask to explain that case.")]


def _final_help(view: PromptView, ask: Ask, intent: str = "help") -> Final | None:
    ref = view.reference
    help_result = view.ok("app_help")
    status = view.ok("app_status")
    if help_result is None and status is None:
        return None
    body: list[str] = []
    allowed = [t for t in ref.targets if t.allowed]
    paragraphs, cited = _help_paragraphs(ref, limit=3, topic=ask.topic)
    # "What is simulated in Demo Mode?", "What can I do in this console?": what/where
    # questions whose answer is the Help Center's own words, then where to see it; a
    # settings page first would answer a different question (Round 13 review).
    template = (view.starter or ("", {}))[0]
    if ask.definition or template in _ORIENTATION_STARTERS:
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
            # Nothing in the Help Center or the console matched (often a question that
            # is not about this deployment at all): say what chat answers (final review L4).
            body.append("The Help Center has no section that answers this directly."
                        + ("" if allowed else f" {_CHAT_SCOPE}"))
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
            sentence = f"This deployment runs version {version.group(1)} with Demo Mode {demo}."
            if ask.wants_overview and not ask.wants_access and not paragraphs:
                # "What version is this?": the deployment fact IS the answer; a console
                # page guessed from the question's words would only distract.
                body = [sentence]
            else:
                body.append(sentence)
    demo_on = "demo_mode=yes" in ref.facts.get("mode", "")
    # In Demo Mode the deployment figures count the configured (real) sources, not
    # the Demo's simulated ones, so they would contradict the console: not shown.
    deployment = status is not None and not ask.wants_access
    return Final(body=body or ["No product reference was available."], blocks=_keep(
        _block(help_result, "guide", view="guide", title="Help Center"),
        None if deployment and demo_on else
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


#: Words of a change request that say nothing about what it changes.
_CHANGE_FILLER = frozenset({
    "the", "and", "all", "any", "our", "your", "its", "their", "this", "that", "these", "those", "now", "can",
    "you", "could", "would", "will", "help", "want", "need", "then", "them", "every", "each", "some", "off",
    "out", "new", "just", "right", "away", "asap", "again", "also", "too", "for", "with", "how",
}) | _TOPIC_STOP_WORDS


def _stem(word: str) -> str:
    """A crude stem, so "cases", "closed" and "closing" meet "case" and "close"."""
    if len(word) > 4 and word.endswith("ies"):
        return word[:-3] + "y"
    if len(word) > 5 and word.endswith("ing"):
        word = word[:-3]
    elif len(word) > 4 and (word.endswith("ed") or (word.endswith("es") and (word[-3] in "sxz"
                                                                               or word[-4:-2] in ("ch", "sh")))):
        word = word[:-2]
    elif len(word) > 3 and word.endswith("s") and not word.endswith("ss"):
        word = word[:-1]
    return word[:-1] if len(word) > 3 and word.endswith("e") else word


def _stems(text: str) -> set[str]:
    return {_stem(w) for w in re.findall(r"[a-z]+", text.lower()) if len(w) >= 3}


@dataclass(frozen=True)
class _ChangeTerms:
    """A change request's words, stemmed: its verb ("kill"), the head noun of the
    verb's direct object ("job" of "Kill the export job") and every word of the verb
    and that object ("kill", "export", "job"). Ids and indicators are left out."""

    verb: str | None = None
    noun: str | None = None
    words: frozenset[str] = frozenset()


def _change_terms(question: str) -> _ChangeTerms:
    # A case id names a case ("Close case-0042 now"); other ids and indicators name
    # nothing a Help Center section is about.
    text = _CASE_ID_RE.sub(" case ", _step_shaped_label(question) or question)
    for pattern in (_URL_RE, _IPV4_RE, _HASH_RE, _DOMAIN_RE):
        text = pattern.sub(" ", text)
    low = text.lower()
    lead = re.match(_POLITE_RE + r"(?:go ahead and\s+)?", low)
    words = re.findall(r"[a-z]+", low[lead.end():] if lead else low)
    if not words:
        return _ChangeTerms()
    rest = " ".join(words[1:])
    cut = _OBJECT_END_RE.search(rest)
    obj = [w for w in (rest[:cut.start()] if cut else rest).split() if len(w) >= 3 and w not in _CHANGE_FILLER]
    verb = _stem(words[0]) if len(words[0]) >= 3 and words[0] not in _CHANGE_FILLER else None
    return _ChangeTerms(verb=verb, noun=_stem(obj[-1]) if obj else None,
                        words=frozenset({_stem(w) for w in obj} | ({verb} if verb else set())))


def _request_words(question: str) -> set[str]:
    """The stemmed content words of a change request, ids and indicators left out."""
    text = _CASE_ID_RE.sub(" case ", _step_shaped_label(question) or question)
    for pattern in (_URL_RE, _IPV4_RE, _HASH_RE, _DOMAIN_RE):
        text = pattern.sub(" ", text)
    return {_stem(w) for w in re.findall(r"[a-z]+", text.lower()) if len(w) >= 3 and w not in _CHANGE_FILLER}


def _says_verb_on_noun(text: str, terms: _ChangeTerms) -> bool:
    """Does ``text`` say the request's verb and then its object within three words
    ("close a case", "restart the poller")?"""
    if not terms.verb or not terms.noun:
        return False
    tokens = [_stem(w) for w in re.findall(r"[a-z]+", text.lower())]
    return any(t == terms.verb and terms.noun in tokens[i + 1:i + 4] for i, t in enumerate(tokens))


def _about_change(section: HelpSection, terms: _ChangeTerms) -> bool:
    """Is a Help Center section about the change asked (final review L4)? Its own
    heading names the object ("Background jobs › Work that uses the job system" for
    "Kill the export job"), its title shares two of the request's verb and object
    words, or its lead says the verb on the object ("close a case"). A word shared
    anywhere is not enough: "Lock the case" never quotes a passage that merely says
    "lock", "Restart the poller" one about restarts, nor "Create a case" one where
    analysts "with cases:write can create" handoff actions."""
    heading = section.title.rsplit("›", 1)[-1]
    if terms.noun and terms.noun in _stems(heading):
        return True
    return len(terms.words & _stems(section.title)) >= 2 or _says_verb_on_noun(_lead(section), terms)


def _change_reference(ref: Reference, question: str) -> tuple[Reference, bool]:
    """The part of ``ref`` about a change request, and whether that is all of it: the
    sections about it, and the console pages a kept section links to or whose label or
    console-map keywords name the object ("Analytics › Jobs" for "Kill the export job",
    "Appearance & customization" for "Change the theme to dark"; never "Overview ›
    Standup" for "Create a case"). The verb alone keeps no page: "change" or "turn"
    is in many keywords."""
    terms = _change_terms(question)
    cited = [s for s in ref.sections if s.ref]
    sections = [s for s in ref.sections if _about_change(s, terms)]
    linked = {c for s in sections for c in s.console}
    # Every content word of the request but its verb ("theme", "dark"; "mfa", "users" of
    # "turn on MFA for all users"), against the page's console-map keywords.
    asked = _request_words(question) - ({terms.verb} if terms.verb else set())
    targets = [t for t in ref.targets
               if t.id in linked or terms.words & _stems(t.label) or asked & _stems(" ".join(t.keywords))]
    whole = bool(cited) and all(s in sections for s in cited)
    return Reference(sections=sections, targets=targets, facts=dict(ref.facts)), whole


def _final_change(view: PromptView, ask: Ask) -> Final:
    body = ["I can't change that from chat: the assistant is read-only, so it can search and explain but "
            "never close, edit, assign or configure anything."]
    # Only a passage and a console page about the request are shown: an unrelated top
    # hit would read as the way to make the change (final review L4). The Help Center
    # card lists every search hit, so it is shown only when all of them are about it.
    ref, whole = _change_reference(view.reference, ask.question)
    paragraphs, cited = _help_paragraphs(ref, limit=1, topic=_change_query(ask))
    console = _console_sentence(ref).replace("Open it in the console:", "Do it in the console:")
    if console:
        body.append(console)
    if paragraphs:
        body.append("From the Help Center:")
        body.extend(paragraphs)
    guide = _block(view.ok("app_help"), "guide", view="guide", title="Help Center") if whole else None
    return Final(body=body, blocks=_keep(guide), citations=cited, console_links=_console_ids(ref),
                 answer_kind="product_help", follow_ups=_follow_ups(view, "change"))


def _final_respond(view: PromptView, ask: Ask) -> Final:
    """A response action (final review L4): no lookup runs and no console page is
    offered, because nothing in this console isolates, blocks, quarantines or stops
    anything. The answer says where the action runs and offers to investigate the
    hosts, users and indicators the analyst named, in their own words."""
    body = ["I can't do that: chat is read-only, and this console has no response actions, so nothing here can "
            "isolate a host, block an address, quarantine a file or stop a process. Run the action in your EDR, "
            "firewall or SOAR tool."]
    targets = _response_targets(ask.question)
    follow_ups: list[str] = []
    for kind, value in targets:
        if kind in ("host", "user") and view.can("search_cases") and not view.case_scoped:
            # An in-depth investigation is a Workspace question (never case-scoped).
            follow_ups.append(f"Investigate everything about {kind} {value}")
        elif kind in ("ip", "domain", "hash") and (view.can("lookup_indicator") or view.can("search_cases")):
            follow_ups.append(f"Check {value}")
    named = _join([_entity_phrase(f"{kind}:{value}") for kind, value in targets])
    if named and follow_ups:
        one = len(targets) == 1
        body.append(f"Before you act, chat can investigate {named}: the cases that involve "
                    f"{'it' if one else 'them'} and {'its' if one else 'their'} log activity.")
    elif follow_ups or view.can("search_cases"):
        body.append("Before you act, ask chat about the host, user or indicator involved: its cases, its log "
                    "activity and, for an indicator, its reputation.")
    follow_ups.extend(f for f in _follow_ups(view, "respond") if f not in follow_ups)
    return Final(body=body, answer_kind="product_help", follow_ups=follow_ups[:3])


def _final_out_of_scope(view: PromptView, ask: Ask) -> Final:
    """A request chat is not for (code, a joke): one honest sentence about what chat
    answers, and starter questions. No lookup, no case list, no Help Center passage
    and no "unsupported" notice: it is not a question about data chat cannot read
    (final review L4, SPEC D9)."""
    kind = _out_of_scope(ask.lowered)
    refusal = {"code": "I can't write code or scripts.",
               "creative": "I can't write jokes, poems or stories."}.get(kind or "", "I can't help with that here.")
    follow_ups = _follow_ups(view, "out_of_scope")
    body = [f"{refusal} {_CHAT_SCOPE}"]
    if follow_ups:
        body.append("Try one of the suggested questions below, or ask about a case, a host, a user or an indicator.")
    return Final(body=body, answer_kind="conversation", follow_ups=follow_ups)


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
        hint = (f" The latest one, {_code(latest.title)}, can be shown as "
                f"{_join([_VIEW_LABEL.get(v, v) for v in latest.views], 'or')}.") if latest else ""
        return Final(body=[f"None of the earlier charts can be shown as a {label}.{hint}"],
                     answer_kind="conversation", follow_ups=_follow_ups(view, "reshape"))
    return Final(body=[f"Here is {_code(chosen.title)} from the earlier answer as a {label}. No new lookup "
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


def _rerun_origin(view: PromptView, ask: Ask) -> Ask | None:
    """The question whose lookups a rerun repeats (the newest earlier question that
    was not itself a rerun), classified again and carrying the window that re-ran:
    its intent picks the answer's shape, its words the answer's wording."""
    probe = PromptView(granted=view.granted, kinds=view.kinds, case_scoped=view.case_scoped,
                       prior_calls=view.prior_calls)
    for index in range(len(view.prior_questions) - 1, -1, -1):
        probe.prior_questions = view.prior_questions[:index]
        # An earlier starter is replayed through its template and fenced slots, never
        # classified from words (#9).
        probe.starter = view.prior_starters[index] if index < len(view.prior_starters) else None
        try:
            origin = classify(view.prior_questions[index], probe)
        except Exception:  # noqa: BLE001 -- advisory: the tool-based answer follows
            return None
        if origin.intent == "rerun":
            continue
        win = ask.win if ask.win is not None and ask.win.spec is not None else (
            origin.win if origin.win is not None and origin.win.spec is not None and ask.win is None else None)
        return replace(origin, win=win, hours=win.hours if win is not None else None, undated=None, unread=None,
                       anchored=False, compare=None, compare_win=None, report=None, save=False)
    return None


def _final_rerun(view: PromptView, ask: Ask, *, head: str | None = None,
                 origin: Ask | None = None) -> Final | None:
    """The earlier lookups re-run (a zero-result suggestion, "the same for all time"):
    the window or the dropped filter that actually ran leads, then the answer in the
    earlier answer's own words (a breakdown reads as a breakdown). A step rerun passes
    its own ``head`` and the ``origin`` question whose answer the step belongs to."""
    results = [r for r in view.results() if r.ok and r.observation is not None]
    if not results:
        return None
    drop = re.search(_WITHOUT_FILTER_RE.pattern, ask.question, re.IGNORECASE)
    phrase = next((p.search(ask.lowered) for p, _keys in _DROP_PHRASES if p.search(ask.lowered)), None)
    compared = ask.compare is not None and ask.intent == "rerun"
    if head is not None:
        pass
    elif compared:
        head = "The same lookup over the same window, compared with the period before it:"
    elif ask.win is not None and ask.win.spec is not None:
        head = f"Re-ran the earlier lookups for {ask.win.phrase}:"
    elif drop:
        head = f"Re-ran the earlier lookups without the {drop.group(1).strip()} filter:"
    elif phrase:
        head = f"Re-ran the earlier lookups {phrase.group(0)}:"
    else:
        head = "Re-ran the earlier lookups:"
    final = None
    origin = origin if origin is not None else _rerun_origin(view, ask)
    if compared:
        origin = None  # the comparison is the answer, in the log or cost words
    if origin is not None and origin.intent in _RERUN_FINALS:
        # The earlier question's own answer shape (a period summary stays a summary,
        # its true positives stay true positives), over the window that re-ran.
        final = _RERUN_FINALS[origin.intent](view, origin)
    if final is not None:
        final.body.insert(0, head)
        final.lead = []
        return final
    tools = [r.tool for r in results]
    builder: Callable[[PromptView, Ask], Final | None] | None = None
    if compared and "log_stats" in tools:
        builder = _final_top
    elif compared and "cost_usage" in tools:
        builder = _final_cost
    elif "case_stats" in tools:
        builder = _final_breakdown
    elif "search_cases" in tools:
        builder = _final_cases
    elif "log_stats" in tools:
        builder = _final_top
    elif "search_logs" in tools:
        builder = _final_logs
    elif "cost_usage" in tools:
        builder = _final_cost
    elif "soc_metrics" in tools:
        builder = _final_posture
    final = builder(view, replace(ask, intent="rerun")) if builder is not None else None
    if final is not None:
        final.body.insert(0, head)
        final.lead = []
        return final
    body = [head]
    for r in results:
        body.extend(_say_result(r)[:3])
    return Final(body=body, blocks=_default_blocks(results), follow_ups=_follow_ups(view, "rerun", charts=True))


def _step_head(step: StepRef, answer: tuple[str, str] | None) -> str:
    """"Step 2 (Counted cases) of my answer to “…”" (engine words, the analyst's quote)."""
    question = _escaped(answer[1] if answer is not None and answer[1] else (step.quote or ""), 120)
    of = f" of my answer to \u201c{question}\u201d" if question else ""
    return f"Step {step.index} ({_escaped(step.label, 80)}){of}"


def _step_args(prior: PriorCall) -> str:
    """A lookup's inputs from the digest as code spans ("`window=last_week`")."""
    shown = [_code(f"{name}={value}", 100) for name, value in prior.args if value][:8]
    return _join(shown) if shown else "its default inputs"


def _step_distinct_args(prior: PriorCall, same: Sequence[PriorCall]) -> str:
    """What sets this lookup apart from its siblings of the same tool, as code spans
    ("`kind=posture`"), or "these inputs" when nothing in the digest does."""
    others = [c for c in same if c is not prior]
    differs = [(name, value) for name, value in prior.args
               if value and others and any(c.arg(name) != value for c in others)]
    # Inputs no sibling shares name it best ("`group_by=ip`"); otherwise any that differ.
    unique = [(name, value) for name, value in differs if all(c.arg(name) != value for c in others)]
    shown = [_code(f"{name}={value}", 100) for name, value in (unique or differs)][:3]
    return _join(shown) if shown else "these inputs"


def _step_shaped(prior: PriorCall, calls: Sequence[PriorCall]) -> str:
    """How one lookup fed its answer, honest about sibling lookups of the same tool:
    a figure is credited to this result only when no other lookup of that tool ran."""
    source = _TOOL_NAMES.get(prior.tool, prior.tool.replace("_", " "))
    if _FAILED_OUTCOME_RE.match(prior.outcome.lower()):
        return ("it did not complete, so the answer could not use it; the answer says what it could not read "
                "and works from the lookups that did complete.")
    if len(calls) == 1:
        return "it was the only lookup that answer ran, so every figure in the answer came from this result."
    same = [c for c in calls if c.tool == prior.tool]
    others = list(dict.fromkeys(_TOOL_NAMES.get(c.tool, c.tool.replace("_", " "))
                                for c in calls if c.tool != prior.tool))
    if len(same) == 1:
        return (f"it was one of {_count(len(calls))} lookups the answer combined; the figures about "
                f"{source} came from this result and the rest from {_join(others)}.")
    mine = _step_distinct_args(prior, same)
    siblings = len(same) - 1
    from_siblings = f"the other {_count(siblings)}" if siblings > 1 else "the other one"
    if not others:
        return (f"it was one of {_count(len(same))} lookups of {source} the answer combined, each over its own "
                f"inputs; the figures for {mine} came from this result and the rest from {from_siblings}.")
    return (f"it was one of {_count(len(same))} lookups of {source} ({_count(len(calls))} lookups in all); the "
            f"{source} figures for {mine} came from this result, the other {source} figures from {from_siblings}, "
            f"and the rest from {_join(others)}.")


_AMBIGUOUS_STEP = ("this conversation no longer tells that answer's lookups of that kind apart by step number, so "
                   "I would be guessing which one it was")


def _final_explain_step(view: PromptView, ask: Ask) -> Final | None:
    """A step of an earlier answer explained from the conversation: what it looked up
    (its inputs), what it found (the stored outcome) and how it shaped that answer.
    Never product help, never a lookup: the run log's own record is the source."""
    step = ask.step
    if step is None:
        return None
    answer = _step_answer(view, step)
    head = _step_head(step, answer)
    purpose = _model_step_purpose(step.label)
    if purpose is not None:
        body = [(f"{head} was {purpose}. It is a model step, not a lookup: it read no data itself, so there is "
                 "nothing it found on its own. The lookups it led to are the steps after it in the run log.")]
        return Final(body=body, answer_kind="conversation")
    if answer is None:
        return Final(body=[(
            f"I can no longer see the answer step {step.index} belongs to in this conversation, so I cannot "
            f"explain {_escaped(step.label, 80) or 'that step'} from here. Open the step in that answer's run log to "
            "see what it looked up and what it returned.")], answer_kind="conversation")
    match = _step_call(view, step, answer[0])
    prior, calls = match.call, match.calls
    if prior is None:
        why = (_AMBIGUOUS_STEP if match.ambiguous
               else "it is not among the lookups this conversation still holds for that answer")
        return Final(body=[(
            f"I cannot explain {head[:1].lower() + head[1:]} from here: {why}. Open the step in that answer's run "
            "log to see exactly what it looked up and what it returned.")], answer_kind="conversation")
    source = _TOOL_NAMES.get(prior.tool, prior.tool.replace("_", " "))
    # The stored outcome as it was written (``NEEDS_HUMAN``, ``a -> b``), escaped, never cut down.
    found = _escaped(prior.outcome, 240) or "no summary was kept"
    body = [
        f"{head} read {source} ({_code(prior.tool)}).",
        f"- **What it looked up:** {_step_args(prior)}.",
        f"- **What it found:** {found.rstrip('.')}.",
        f"- **How it shaped the answer:** {_step_shaped(prior, calls)}",
        ("Open the step in the run log to see exactly what it returned, or ask me to run it again for fresh "
         "figures."),
    ]
    return Final(body=body, answer_kind="conversation")


def _final_rerun_step(view: PromptView, ask: Ask) -> Final | None:
    """One step of an earlier answer re-run with its own inputs: a head naming the step
    (and any input that could not be read back), then the result in that answer's own
    shape (its question classified again)."""
    step = ask.step
    if step is None:
        return None
    answer = _step_answer(view, step)
    head = _step_head(step, answer)
    lowered = head[:1].lower() + head[1:]
    match = _step_call(view, step, answer[0]) if answer is not None else StepMatch(None)
    prior = match.call
    inp, dropped = _step_rerun_input(prior) if prior is not None else ({}, [])
    reason = None
    if _model_step_purpose(step.label) is not None:
        reason = "it is a model step, not a lookup, so there is nothing to re-run"
    elif answer is None:
        reason = "I can no longer see the answer it belongs to in this conversation"
    elif prior is None:
        reason = (_AMBIGUOUS_STEP if match.ambiguous
                  else "it is not among the lookups this conversation still holds for that answer")
    elif prior.tool in _NO_STEP_RERUN:
        reason = _NO_STEP_RERUN[prior.tool]
    elif not view.can(prior.tool, inp.get("kind")):
        reason = f"you no longer have access to {_TOOL_NAMES.get(prior.tool, prior.tool.replace('_', ' '))}"
    elif not view.results():
        reason = "that lookup did not run this time"
    if reason is not None:
        return Final(body=[(f"I could not run {lowered} again: {reason}. Ask the original question again to "
                            "refresh its figures.")], answer_kind="conversation")
    origin: Ask | None = None
    if answer is not None and answer[1]:
        probe = PromptView(granted=view.granted, kinds=view.kinds, case_scoped=view.case_scoped,
                           prior_calls=view.prior_calls)
        try:
            classified = classify(answer[1], probe)
        except Exception:  # noqa: BLE001 -- advisory: the tool-based answer follows
            classified = None
        if classified is not None and classified.intent in _RERUN_FINALS:
            win = classified.win if classified.win is not None and classified.win.spec is not None else None
            origin = replace(classified, win=win, hours=win.hours if win is not None else None, undated=None,
                             unread=None, anchored=False, compare=None, compare_win=None, report=None, save=False)
    if dropped:
        names = _join([_code(name, 40) for name in dropped])
        inputs = "that input" if len(dropped) == 1 else "those inputs"
        rerun_head = (f"Re-ran {lowered} without {names}: the conversation no longer holds "
                      f"{'its' if len(dropped) == 1 else 'their'} full value, so this run used the lookup's "
                      f"default for {inputs}. Its other inputs are the same:")
    else:
        rerun_head = f"Re-ran {lowered} with the same inputs:"
    final = _final_rerun(view, ask, head=rerun_head, origin=origin)
    if final is None:
        # The re-run did not complete: the answer still names the step it re-ran.
        failed_head = (f"{rerun_head[:-1]}. It" if dropped else f"Re-ran {lowered} with the same inputs: it")
        return _rerun_step_failed(view, prior, failed_head)
    final.answer_kind = "data"
    return final


def _rerun_step_failed(view: PromptView, prior: PriorCall, head: str) -> Final | None:
    """A step re-run whose lookup did not complete: ``head`` ("Re-ran step 2 (…) of my
    answer to “…” with the same inputs: it"), whether it failed again (the run log's
    record says it failed before) or only this time, why, and what to do next. The
    failure is told here, so it is not listed again below."""
    failed = next((r for r in view.failed() if r.tool == prior.tool), None)
    if failed is None:
        return None
    reason = _escaped(failed.summary, 160) or failed.status
    before = bool(_FAILED_OUTCOME_RE.match(prior.outcome.strip().lower()))
    again = "failed again" if before else "did not complete this time"
    body = [f"{head} {again} ({_code(failed.tool)} {failed.status}: {reason})."]
    if REFUSED_TAINT in (failed.summary or ""):
        body.append("Indicator lookups run only for a value you typed yourself or one a lookup found as evidence "
                    "for the same question, and a retried step cannot show where its value came from. Ask about "
                    "the indicator by name to look it up again.")
    elif before:
        body.append("The same inputs fail the same way, so running this step again will not change the result "
                    "until what it reads changes. Ask the original question again, or ask it another way, to look "
                    "it up differently.")
    else:
        body.append("The earlier result still stands in that answer. Try the step again in a moment, or ask the "
                    "original question again.")
    return Final(body=body, answer_kind="data", narrated={failed.ordinal})


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
    orientation = ask.intent == "fallback"
    if orientation:
        # The orientation answer (chat-revamp §5.5): what chat answers, then where
        # things stand (final review L4: never an unrelated Help Center passage).
        body.append(f"I could not map that to one specific lookup. {_CHAT_SCOPE}"
                    + (" Here is where things stand:" if data else ""))
    elif lead and data:
        # The direct answer to "why is this not the answer I asked for".
        reads = "what you can read" if locked else "what those scopes cover"
        body.append(f"{lead}, so this answer uses {reads}:")
    elif lead:
        # Nothing data-bearing ran: the missing access IS the answer, so it leads.
        body.append(f"{lead}, so no data backs this answer. {advice}".strip())
        advice = ""
    narration: list[str] = []
    for r in data:
        narration.extend(_say_result(r)[:4])
    if data and not body and narration and narration[0].startswith(("- ", "1. ")):
        # A bare list (runbook titles, say) needs a lead-in; a sentence speaks for itself.
        body.append("These match your question:")
    body.extend(narration)
    # In a degraded answer only excerpts that match the question's topic are worth
    # showing; an unrelated top hit would read as an answer it is not. The orientation
    # answer points to the Help Center's Workspace Chat section only.
    if orientation:
        paragraphs, cited = _orientation_pointer(view.reference)
        body.extend(paragraphs)
    else:
        paragraphs, cited = _help_paragraphs(view.reference, topic=ask.topic or ask.question, require_match=True)
        if paragraphs:
            body.append("From the Help Center:")
            body.extend(paragraphs)
    # The orientation lookup's console pages answer nothing that was asked.
    console = "" if orientation else _console_sentence(view.reference)
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
                 console_links=[] if orientation else _console_ids(view.reference), answer_kind=kind,
                 unsupported=unsupported, follow_ups=_follow_ups(view, ask.intent, charts=bool(data)),
                 lead=[p for p in (opening, first) if p], notes=[n for n in notes if n])


def _orientation_pointer(ref: Reference) -> tuple[list[str], list[str]]:
    """``(lines, cited ids)``: one pointer to the Help Center's Workspace Chat section
    the orientation lookup returned ("To see what else you can ask, read …"), never a
    quoted passage: the lookup searched for how to ask, not for the question asked."""
    for section in ref.sections:
        if section.ref and section.title.strip().lower().startswith("workspace chat"):
            return ([f"To see what else you can ask, read **{display_text(section.title, 120)}** [{section.ref}] "
                     "in the Help Center."], [section.ref])
    return [], []


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
        return _score(value)
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
        return f"{sign}{_points(abs(change))} points"
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


def _note_text(note: str) -> str:
    """A comparison's engine note in reader words: the instruction to the model ("…;
    say so.") becomes a plain statement."""
    text = re.sub(r";\s*say so\.?\s*$", ".", note.strip())
    return _plain(text, 240)


#: A period phrase that ends in its dates in brackets ("the previous 90 days (16 Apr to
#: 14 Jul 2026)", "the last 90 days (since 15 Jul 2026)").
_DATED_TAIL_RE = re.compile(r"\([^()]*\d{4}\)$")


def _with_change(phrase: str, change: str) -> str:
    """``phrase`` and its change in brackets: "in Sep 2026 to date (+17, +56.7%)". A
    phrase that already ends in bracketed dates takes the change inside them, "in the
    previous 90 days (16 Apr to 14 Jul 2026; new)", never two brackets in a row."""
    if _DATED_TAIL_RE.search(phrase):
        return f"{phrase[:-1]}; {change})"
    return f"{phrase} ({change})"


def _the(period: str) -> str:
    """A compared period as a noun phrase: "the previous 90 days (16 Apr to 14 Jul
    2026)", "the same 90 days a year earlier"; a calendar name stays as it is ("Sep
    2026")."""
    return f"the {period}" if period.lower().startswith(("previous ", "same ")) else period


def _period_plain(label: str, other: str) -> str:
    """A compared period's plain name once its dates have been stated: "last 90 days"
    for "last 90 days (since 15 Jul 2026)", "previous 90 days" for "previous 90 days (16
    Apr to 14 Jul 2026)". A name without dates in brackets stays whole, and so does one
    whose plain name is the other period's too (two "last 90 days" never read alike)."""
    short = _DATED_TAIL_RE.sub("", label).rstrip()
    if not short or short == label or short == _DATED_TAIL_RE.sub("", other).rstrip():
        return label
    return short


def _lower_head(text: str) -> str:
    """``text`` with its first letter lower-cased for the middle of a sentence
    ("True-positive rate" → "true-positive rate"); an acronym ("MTTR") or a value in
    inline code keeps its case."""
    if len(text) > 1 and text[0].isupper() and text[1].islower():
        return text[0].lower() + text[1:]
    return text


def _merged_labels(labels: Sequence[str]) -> str:
    """Several row names as one subject: "False-positive and true-positive rates" when
    they share a last word, else "MTTR (median) and false-positive rate"."""
    words = [label.rsplit(" ", 1) for label in labels]
    if (len(labels) > 1 and all(len(w) == 2 and w[1].isalpha() for w in words)
            and len({w[1].lower() for w in words}) == 1):
        tail = words[0][1]
        heads = [words[0][0], *(_lower_head(w[0]) for w in words[1:])]
        return f"{_join(heads)} {tail if tail.endswith('s') else tail + 's'}"
    return _join([labels[0], *(_lower_head(label) for label in labels[1:])])


def _say_unmeasured(rows: Sequence[tuple[str, str]], known: set[str], name: Callable[[str], str],
                    subject: str, baseline: str) -> str:
    """The rows a comparison's baseline has no figure for, in ONE sentence
    (:func:`_say_comparison`): "False-positive rate: **56.6%** in the last 90 days; not
    measured in the previous 90 days, so there is no change to show." for one row;
    "False-positive rate **56.6%** and true-positive rate **27.7%** in the last 90 days;
    neither was measured in the previous 90 days, …" for several; and, when the caller
    already gave every value (``known``), the names only: "False-positive and
    true-positive rates were not measured in the previous 90 days, so there is no change
    to show." ``name`` gives each period its words (dated on first mention)."""
    labels = [label for label, _value in rows]
    if all(label.lower() in known for label in labels):
        verb = "were" if len(rows) > 1 else "was"
        return f"{_merged_labels(labels)} {verb} not measured {_in(name(baseline))}, so there is no change to show."
    if len(rows) == 1:
        label, value = rows[0]
        return (f"{label}: **{value}** {_in(name(subject))}; not measured {_in(name(baseline))}, "
                "so there is no change to show.")
    figures = _join([f"{rows[0][0]} **{rows[0][1]}**", *(f"{_lower_head(label)} **{value}**"
                                                       for label, value in rows[1:])])
    nothing = "neither" if len(rows) == 2 else "none"
    return (f"{figures} {_in(name(subject))}; {nothing} was measured {_in(name(baseline))}, "
            "so there is no change to show.")


def _say_comparison(comp: Mapping[str, Any], *, limit: int = 5, plain_labels: bool = True,
                    skip: Iterable[str] = (), with_note: bool = True, bullets: bool = False,
                    stated: Iterable[str] = (), known: Iterable[str] = ()) -> list[str]:
    """``Cases: **47** in Oct 2026 to date vs 30 in Sep 2026 to date (+17, +56.7%).``
    per row (the subject against its baseline; a list item with ``bullets``), then the
    in-progress note as its own paragraph.

    Each period is named with its dates once, on its first mention (or never, when the
    caller already ``stated`` that name in full), and plainly after: "Cases: **83** in
    the last 90 days (since 15 Jul 2026) vs 0 in the previous 90 days (16 Apr to 14 Jul
    2026; new)." then "MTTR median: **20 min** in the last 90 days vs 30 min in the
    previous 90 days (−10 min)." The rows the baseline has no figure for are said in
    one sentence, not one each; when the caller already gave their values (``known``:
    the row labels, any case), it names them only ("False-positive and true-positive
    rates were not measured in the previous 90 days, so there is no change to show")."""
    periods = [display_text(p, _PERIOD_CHARS) for p in comp.get("periods") or [] if isinstance(p, str)]
    subject = display_text(comp.get("subject"), _PERIOD_CHARS) or (periods[-1] if periods else "this period")
    baseline = (display_text(comp.get("baseline"), _PERIOD_CHARS)
                or (periods[-2] if len(periods) > 1 else "the period before"))
    try:
        cur_at, base_at = periods.index(subject), periods.index(baseline)
    except ValueError:
        cur_at, base_at = -1, -2
    said = {display_text(s, _PERIOD_CHARS) for s in stated if isinstance(s, str)}
    plain = {subject: _period_plain(subject, baseline), baseline: _period_plain(baseline, subject)}

    def name(period: str) -> str:
        if period in said:
            return plain.get(period, period)
        said.add(period)
        return period

    skipped = {s.lower() for s in skip}
    rows = [r for r in comp.get("rows") or [] if isinstance(r, Mapping)
            and display_text(r.get("label"), _NARRATED_CHARS).lower() not in skipped]
    # Read every row first: the rows the baseline has no figure for are said together,
    # where the first of them falls.
    measured: list[tuple[str, str, str, str]] = []           # (label, value, baseline value, change)
    unmeasured: list[tuple[str, str]] = []                   # (label, value)
    order: list[int | None] = []                             # index into measured; None = the group
    for row in rows[:limit]:
        values = row.get("values") if isinstance(row.get("values"), list) else []
        if len(values) < 2 or all(_num(v) is None for v in (values[cur_at], values[base_at])):
            continue
        label = display_text(row.get("label"), _NARRATED_CHARS) if plain_labels else _code(row.get("label"))
        unit = row.get("unit")
        if _num(values[base_at]) is None:
            if not unmeasured:
                order.append(None)
            unmeasured.append((label, _value_text(values[cur_at], unit)))
            continue
        flags = [_change_text(row)] + (["small sample"] if row.get("small_sample") and unit != "count" else [])
        order.append(len(measured))
        measured.append((label, _value_text(values[cur_at], unit), _value_text(values[base_at], unit),
                         "; ".join(flags)))
    known_labels = {k.lower() for k in known if isinstance(k, str)}
    out: list[str] = []
    for at in order:
        if at is None:
            out.append(_say_unmeasured(unmeasured, known_labels, name, subject, baseline))
            continue
        label, value, before, change = measured[at]
        now_words = _in(name(subject))
        out.append(f"{label}: **{value}** {now_words} vs {before} {_with_change(_in(name(baseline)), change)}.")
    if bullets:
        out = [f"- {line}" for line in out]
    note = comp.get("note")
    if with_note and isinstance(note, str) and note.strip() and out:
        out.append(_note_text(note))
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
        text = display_text(label, _NARRATED_CHARS)
        if field in ("assignee", "closed_by") and text in ("Unassigned", "Not closed"):
            return text.lower()
        return _code(label)
    return display_text(label, _NARRATED_CHARS) or "(none)"


def _stats_groups(o: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    return [g for g in o.get("groups") or [] if isinstance(g, Mapping)]


#: The order a severity, verdict, status or priority breakdown is narrated in, by its
#: display label: the chart and table beside it use the same order (Round 12 SPEC §7.2
#: decision 27), so the prose never reads "Low, High, Critical".
_CANONICAL_LABELS: dict[str, tuple[str, ...]] = {
    "severity": ("critical", "high", "medium", "low", "info"),
    "verdict": ("true positive", "false positive", "needs human"),
    "status": ("new", "open", "open · awaiting analyst", "investigating", "escalated", "on hold",
               "resolved", "closed"),
    "priority": ("p1", "p2", "p3", "p4"),
}


def _canonical_rank(field: str, label: Any) -> int:
    """``label``'s place in ``field``'s canonical order (0 for a field without one, the
    end for a value outside it); sorting by it is stable, so volume order stays inside."""
    order = _CANONICAL_LABELS.get(field)
    if order is None:
        return 0
    text = str(label or "").strip().lower()
    return order.index(text) if text in order else len(order)


def _stats_noun(o: Mapping[str, Any]) -> str:
    filters = _filters_of(o)
    return _case_noun(filters, "case")


def _stats_lead(o: Mapping[str, Any]) -> str:
    """"**19 cases are open right now**" or "**47 cases** over all time (since …)"."""
    total = _num(o.get("total")) or 0
    filters = _filters_of(o)
    window = _window(o, "all time")
    exact = "" if o.get("exact", True) is not False else " (a partial count)"
    about = _entity_about(filters)
    if filters.get("status_group") == "active" and window.lower().startswith("all time"):
        verb = "is" if int(total) == 1 else "are"
        return f"**{_plural(total, 'case')}{about} {verb} open right now**{exact}"
    return f"**{_plural(total, _stats_noun(o))}**{about} {_in(window)}{exact}"


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


def _say_two_field_counts(o: Mapping[str, Any], first: str, second: str) -> str:
    """"Open: high 5, medium 3; Closed: low 40 and medium 2." for a two-field grouping."""
    rows = [g for g in _stats_groups(o) if isinstance(g.get("key"), Mapping)]
    outer: dict[str, list[tuple[str, float]]] = {}
    for g in rows:
        head = _group_value(first, _dig(g, "key", first))
        outer.setdefault(head, []).append((_group_value(second, _dig(g, "key", second)),
                                           _num(_dig(g, "metrics", "count")) or 0))
    parts = []
    heads = sorted(outer.items(), key=lambda item: _canonical_rank(first, item[0]))
    for head, inner in heads[:6]:
        total = sum(n for _label, n in inner)
        shown = sorted(sorted(inner, key=lambda item: -item[1])[:5], key=lambda item: _canonical_rank(second, item[0]))
        parts.append(f"{head} {_count(total)} ({_join([f'{label} {_count(n)}' for label, n in shown])})")
    if not parts:
        return ""
    name = {"status_group": "open or closed"}.get(first, first.replace("_", " "))
    return f"By {name}, then {second.replace('_', ' ')}: " + "; ".join(parts) + "."


def _say_bucketed_group_totals(o: Mapping[str, Any]) -> str:
    """"By severity over the whole window: High 24, Low 46 …" for a grouping drawn per
    period ("cases by month and severity"): each group summed over the periods."""
    fields = [f for f in o.get("group_by") or [] if isinstance(f, str)]
    if not o.get("bucket") or len(fields) != 1:
        return ""
    field = fields[0]
    totals: dict[str, float] = {}
    for g in _stats_groups(o):
        if not isinstance(g.get("key"), Mapping):
            continue
        label = _group_value(field, _dig(g, "key", field))
        totals[label] = totals.get(label, 0) + (_num(_dig(g, "metrics", "count")) or 0)
    ranked = [(label, n) for label, n in sorted(totals.items(), key=lambda kv: (-kv[1], kv[0])) if n][:8]
    ranked.sort(key=lambda kv: _canonical_rank(field, kv[0]))
    if not ranked:
        return ""
    name = {"status_group": "open or closed", "mitre_technique": "ATT&CK technique",
            "mitre_tactic": "ATT&CK tactic"}.get(field, field.replace("_", " "))
    return (f"By {name} over the whole window: {_join([f'{label} {_count(n)}' for label, n in ranked])}; the "
            "stacked chart splits each period.")


def _say_group_counts(o: Mapping[str, Any]) -> str:
    fields = [f for f in o.get("group_by") or [] if isinstance(f, str)]
    if not fields or o.get("bucket"):
        return ""
    if len(fields) >= 2:
        return _say_two_field_counts(o, fields[0], fields[1])
    field = fields[0]
    rows = [g for g in _stats_groups(o) if isinstance(g.get("key"), Mapping)]
    shown = sorted(rows[:8], key=lambda g: _canonical_rank(field, _dig(g, "key", field)))
    parts = [f"{_group_value(field, _dig(g, 'key', field))} {_count(_dig(g, 'metrics', 'count'))}" for g in shown]
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
        summed = sum(_num(_dig(g, "metrics", "count")) or 0 for g in rows) + (other or 0)
        total = _num(o.get("total"))
        # Only a sum that does exceed the total is said to (two cases on two rules add up).
        verb = "add up" if total is not None and summed > total else "can add up"
        text += f" A case can count under several {_plural_noun(name)}, so these {verb} to more than the total."
    return text


_TOTAL_WORDS = {"fp_rate": "false-positive rate", "tp_rate": "true-positive rate", "auto_closed": "closed automatically",
                "human_closed": "closed by an analyst", "analyst_fp": "confirmed false positives by analysts",
                "mttr_p50": "MTTR median", "mtta_p50": "MTTA median", "mttd_p50": "MTTD median",
                "mttr_p90": "MTTR p90", "mtta_p90": "MTTA p90", "mttd_p90": "MTTD p90", "mean_risk": "average risk",
                "open_now": "open now"}


def _say_stats_totals(o: Mapping[str, Any], *, limit: int | None = None) -> str:
    """The totals of the metrics a ``case_stats`` counted, in words (the first
    ``limit`` of them when a key-figures block beside the prose shows every one, T15)."""
    totals = o.get("totals") if isinstance(o.get("totals"), Mapping) else {}
    units = o.get("units") if isinstance(o.get("units"), Mapping) else {}
    parts: list[str] = []
    for metric in [m for m in o.get("metrics") or [] if isinstance(m, str)]:
        if metric == "count" or metric not in _TOTAL_WORDS:
            continue
        if limit is not None and len(parts) >= limit:
            break
        value = totals.get(metric)
        unit = units.get(metric)
        if metric in ("auto_closed", "human_closed", "analyst_fp", "open_now"):
            parts.append(f"{_count(value)} {_TOTAL_WORDS[metric]}")
        else:
            parts.append(f"{_TOTAL_WORDS[metric]} {_value_text(value, unit)}")
    return (_sentence(_join(parts)) if parts else "")


def _zero_suggestions(o: Mapping[str, Any], *, keep: Sequence[str] = ()) -> tuple[str, list[str]]:
    """``(sentence, follow-ups)`` from a zero-match result's engine-built suggestions:
    each becomes a one-click question that re-runs the lookup (SPEC D10), worded
    exactly as the console's zero-result chips word it (``suggestion_question``).
    ``keep`` names the filters the question is about ("entity" for "which cases
    involve this host?"): dropping one of those would answer another question, so it
    is never suggested."""
    kept = {f"without the {name} filter" for name in keep}
    labels = [display_text(s.get("label"), 60) for s in o.get("suggestions") or [] if isinstance(s, Mapping)]
    labels = [label for label in labels if label and label.casefold() not in kept]
    if not labels:
        return "", []
    follow = []
    ways: list[str] = []
    for label in labels[:3]:
        low = label[:1].lower() + label[1:]
        key = label.casefold()
        question = suggestion_question(label)
        if question:
            follow.append(question)
        if key == "all time":
            ways.append("look over all time")
        elif key.startswith("without the "):
            ways.append(f"drop the {low[len('without the '):]}")
        elif key.startswith(("last ", "this ")):
            ways.append(f"look at the {low}" if key.startswith("last ") else f"look at {low}")
        elif key == "open and closed cases":
            ways.append("include closed cases")
        elif key == "any severity":
            ways.append("include any severity")
        elif key == "all sources":
            ways.append("look across all sources")
        else:
            ways.append(f"look at {low}")
    return f"To widen it, {_join(ways, 'or')}.", follow


def _count_row(comp: Mapping[str, Any] | None) -> Mapping[str, Any] | None:
    """A comparison's case-count row ("Cases"), else None."""
    rows = [r for r in (comp or {}).get("rows") or [] if isinstance(r, Mapping)]
    return next((r for r in rows if display_text(r.get("label"), 60).lower() == "cases"), None)


def _zero_with_baseline(o: Mapping[str, Any]) -> list[str]:
    """A zero current period whose baseline had cases: the fall to zero IS the answer
    ("Down to 0 from 4 in Sep 2026 to date"), then the compared rows; [] otherwise."""
    comp = _comparison_of(o)
    row = _count_row(comp)
    values = row.get("values") if row is not None and isinstance(row.get("values"), list) else []
    baseline = display_text((comp or {}).get("baseline"), _PERIOD_CHARS) or "the previous period"
    periods = [display_text(p, _PERIOD_CHARS) for p in (comp or {}).get("periods") or [] if isinstance(p, str)]
    at = periods.index(baseline) if baseline in periods and len(periods) == len(values) else len(values) - 2
    before = _num(values[at]) if len(values) >= 2 and 0 <= at < len(values) else None
    if comp is None or before is None:
        return []
    if not before:
        # Nothing in either period: said once, with no change to show.
        hint, _follow = _zero_suggestions(o)
        return [f"No {_stats_noun(o)} matched {_in(_window(o, 'all time'))}, and none {_in(baseline)} either."
                + (f" {hint}" if hint else "")]
    lead = (f"No {_stats_noun(o)} matched {_in(_window(o, 'all time'))}: down to 0 from {_count(before)} "
            f"{_in(baseline)}.")
    lines = [line for line in _say_comparison(comp, bullets=True)
             if not line.startswith(("- Cases:",))]
    return [lead, *(["Compared with the previous period:", *lines] if lines else [])]


def _relabel_count(comp: Mapping[str, Any], filters: Mapping[str, Any]) -> Mapping[str, Any]:
    """``comp`` with its "Cases" row named after the filters ("Critical cases",
    "Cases involving `pnair`"), so a filtered count never reads as every case."""
    filters = {k: v for k, v in filters.items() if v not in (None, "", [])}
    if not filters:
        return comp
    noun = _plural_noun(_case_noun(filters, "case")) + _entity_about(filters)
    noun = noun[:1].upper() + noun[1:]
    return {**comp, "rows": [{**r, "label": noun} if isinstance(r, Mapping) and r.get("label") == "Cases" else r
                             for r in comp.get("rows") or []]}


def _say_case_stats(r: Result) -> list[str]:
    o = r.obs
    total = _num(o.get("total")) or 0
    if not total:
        dropped = _zero_with_baseline(o)
        if dropped:
            return dropped
        hint, _follow = _zero_suggestions(o)
        zero_filters = _filters_of(o)
        rule = zero_filters.get("rule")
        # Round 12 WP-ASK: a rule-filtered zero names the rule it counted.
        from_rule = f" from rule {_code(rule)}" if isinstance(rule, str) and rule.strip() else ""
        if zero_filters.get("assignee") == _ASSIGNEE_ME:
            from_rule += " assigned to you"
        return [f"No {_stats_noun(o)}{from_rule} matched {_in(_window(o, 'all time'))}." + (f" {hint}" if hint else "")]
    out = [_stats_lead(o) + "."]
    # T15: when the figures show as one key-figures block (no series, no breakdown) of
    # three or more, the lead names the count and the prose one more figure.
    figures = [m for m in o.get("metrics") or [] if m == "count" or m in _TOTAL_WORDS]
    as_kpis = not (r.artifact("series") or r.artifact("categories")) and len(figures) >= 3
    for sentence in (_say_bucket_counts(o) if o.get("bucket") else "",
                     _say_group_counts(o) or _say_bucketed_group_totals(o),
                     _say_stats_totals(o, limit=1 if as_kpis else None)):
        if sentence:
            out.append(sentence)
    if o.get("partial"):
        out.append(_plain(o.get("partial"), 240))
    filters = _filters_of(o)
    if filters.get("status_group") == "terminal" and not _window(o, "all time").lower().startswith("all time"):
        # The window is creation time: say so, so "closed this month" is read right.
        out.append("The window counts cases by when they were opened, so these are the cases opened in it that "
                   "are now closed.")
    comp = _comparison_of(o)
    if comp:
        out.append("Compared with the previous period:")
        out.extend(_say_comparison(_relabel_count(comp, filters), bullets=True))
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


def _age_lead(ask: Ask, o: Mapping[str, Any], count: Any, noun: str) -> str | None:
    """"**14 open cases** were opened more than 3 days ago (before 7 Oct 2026 12:00)."
    for a case-age question (the window is an upper bound on the opening time)."""
    if ask.win is None or not ask.win.older:
        return None
    label = _window(o, "")
    when = f" ({label.replace('until ', 'before ', 1)})" if label.startswith("until ") else ""
    verb = "was" if _num(count) == 1 else "were"
    filters = _filters_of(o)
    return f"**{_plural(count, noun)}**{_entity_about(filters)} {verb} {ask.win.phrase}{when}."


def _closer_caveat(ask: Ask, groups: Sequence[str]) -> str:
    """What a "who closed" grouping can and cannot say (the case store records the
    assignee and the kind of decider, never which analyst pressed close)."""
    if "closed_by" in groups:
        return ("These count who decided each close (the AI agent, an analyst, the system or an analyst policy); "
                "chat cannot name the analyst who closed a case.")
    if "assignee" in groups and re.search(r"\b(?:closed|resolved|close|resolve)\b", ask.lowered):
        return ("Chat counts closed cases by the analyst they are assigned to; it does not record which analyst "
                "closed each one.")
    return ""


def _auto_close_lead(ask: Ask, o: Mapping[str, Any]) -> str:
    """"**33 cases** opened in October 2026 were closed automatically by the AI agent
    (of 36 closed cases)." for a question about the AI's (automatic) closes."""
    if not _AUTO_CLOSE_RE.search(ask.lowered):
        return ""
    totals = o.get("totals") if isinstance(o.get("totals"), Mapping) else {}
    auto = _num(totals.get("auto_closed"))
    if auto is None:
        return ""
    filters = _filters_of(o)
    window = _window(o, "all time")
    all_time = window.lower().startswith("all time")
    opened = "" if all_time else f" opened {_in(window)}"
    when = f" {_in(window)}" if all_time else ""
    about = _entity_about(filters)
    share = _SHARE_CUE_RE.search(ask.lowered) is not None
    within = _within_auto_closed(ask.lowered) if share else None
    if within is not None and within[0]:
        # "What % of the auto-closed cases were false positives?": a share WITHIN the
        # AI's closes, from the group the plan split them by.
        field, value, words = within

        def plain(text: Any) -> str:  # "FALSE_POSITIVE", "False positive" -> "false positive"
            return re.sub(r"[\s_-]+", " ", str(text or "")).strip().lower()

        part = sum(_num(_dig(g, "metrics", "auto_closed")) or 0 for g in _stats_groups(o)
                   if plain(_dig(g, "key", field)) == plain(value))
        if auto <= 0:
            return f"The AI agent closed no case{about}{opened}{when}, so there is no share to give."
        return (f"**{_pct(round(100.0 * part / auto, 1))}** of the {_plural(auto, 'case')}{about}{opened} that the "
                f"AI agent closed{when} were {words}: {_count(part)} of {_count(auto)}.")
    rate = _automation_rate(auto, totals.get("human_closed")) if share and within is None else None
    if rate is not None:
        # "What percentage of cases were auto closed?": the share leads, as a share of
        # the closed cases the question names, with the counts it is computed from. It
        # is the automation rate only when no filter but "closed" narrows the cases.
        closed = auto + (_num(totals.get("human_closed")) or 0)
        named = {k: v for k, v in filters.items() if k not in ("status", "status_group")}
        noun = _case_noun({**named, "status_group": "terminal"}, "case")
        narrowed = any(v not in (None, "", [], {}) for v in named.values())
        return (f"**{_pct(rate)}** of the {noun}s{about}{opened} were closed automatically by the AI agent{when}: "
                f"{_count(auto)} of {_plural(closed, noun)}." + ("" if narrowed else " This is the automation rate."))
    verb = "was" if auto == 1 else "were"
    lead = (f"**{_plural(auto, 'case')}**{about}{opened} {verb} closed automatically by the AI agent (of "
            f"{_plural(o.get('total'), _stats_noun(o))}).")
    if within is not None:
        # A part chat cannot count ("were reopened"): the closes it can count, said so.
        lead += " Chat can split the AI agent's closes by verdict or severity only."
    return lead


def _is_oldest_open(r: Result) -> bool:
    """A case list of OPEN cases sorted oldest first (the breakdown's own companion
    lookup for "when were they opened?" and age questions)."""
    filters = _filters_of(r.obs)
    status_group = r.input.get("status_group") or filters.get("status_group")
    return status_group == "active" and r.input.get("sort_order") == "asc"


def _final_breakdown(view: PromptView, ask: Ask) -> Final | None:
    stats = view.ok("case_stats")
    if stats is None:
        return None
    o = stats.obs
    total = _num(o.get("total")) or 0
    body = _say_case_stats(stats)
    age = _age_lead(ask, o, total, _stats_noun(o)) if total else None
    if age and body:
        body[0] = age
    auto_lead = _auto_close_lead(ask, o) if total else ""
    if auto_lead and body:
        # "How many cases did the AI close?": the figure asked for leads (it names the
        # closed total too, so it replaces the plain count).
        body[0] = auto_lead
    verdicts = _group_counts(stats, "verdict") if total and _volume_and_verdict(ask.lowered) else {}
    if verdicts and body:
        # "Case volume and false positives": the lead names both (Round 13 T37).
        word = ("true positive" if re.search(r"\btrue[- ]positives?\b", ask.lowered)
                and not re.search(r"\bfalse[- ]positives?\b", ask.lowered) else "false positive")
        n = verdicts.get(word, 0)
        body[0] = (body[0].rstrip(".") + f", {_count(n)} of them {_plural_noun(word) if n != 1 else word}"
                   + f" ({_pct(100 * n / total)}).")
        body = [body[0]] + [p for p in body[1:] if not re.match(r"^(?:False|True)-positive rate [\d.,]+%\.$", p)]
    caveat = _closer_caveat(ask, [g for g in o.get("group_by") or [] if isinstance(g, str)])
    if caveat and total:
        body.insert(min(2, len(body)), caveat)
    listed = view.ok("search_cases")
    # "The oldest still open" only for the plan's own oldest-open list (open cases,
    # oldest first); any other case list (a rerun of a period summary's riskiest true
    # positives) is narrated as the list it is.
    oldest = listed if listed is not None and _is_oldest_open(listed) else None
    if oldest is not None and total:
        cases = [c for c in oldest.obs.get("cases") or [] if isinstance(c, Mapping)]
        if cases:
            first = cases[0]
            created = _date_text(first.get("created_at"))
            # Opened at the same moment: the oldest are all of them, said as a tie (PB5).
            at = _instant(first.get("created_at"))
            tied = [c for c in cases[1:] if at is not None and _instant(c.get("created_at")) == at]
            if tied:
                body.append(f"The oldest still open are {_case_head(first, bold=False)} and "
                            f"{_peers([_case_ref(c) for c in tied])}, opened at the same time"
                            + (f" ({created})." if created else "."))
            else:
                body.append(f"The oldest still open is {_case_head(first, bold=False)}, opened {created}."
                            if created else f"The oldest still open is {_case_head(first, bold=False)}.")
            rest = _case_bullets(oldest, limit=5)[1 + len(tied):]
            if rest:
                body.append("The next oldest:")
                body.extend(rest)
    elif listed is not None and total:
        body.append(_say_search_cases(listed))
        body.extend(_case_bullets(listed))
    volume = view.ok("case_stats", where=lambda r: r is not stats and bool(r.obs.get("bucket")))
    if volume is not None and volume is not stats:
        sentence = _say_bucket_counts(volume.obs, unit_word=f"Cases opened per {volume.obs.get('bucket')}")
        if sentence:
            body.append(sentence)
    blocks = _stats_blocks(stats, series_view="stacked_bar" if o.get("group_by") and o.get("bucket") else "bar")
    if volume is not None and volume is not stats:
        blocks += _keep(_block(volume, "series", view="bar"))
    rated = view.ok("case_stats", where=lambda r: r is not stats and r.input.get("group_by") == ["rule"]
                    and bool({"fp_rate", "tp_rate"} & set(r.input.get("metrics") or [])))
    if rated is not None and total:
        # T37: which rules the false (or true) positives come from, with each rule's rate.
        rate_word = "true-positive" if "tp_rate" in (rated.input.get("metrics") or []) else "false-positive"
        blocks += _keep(_block(rated, "table", view="table", title=f"Cases and {rate_word} rate by rule"))
    if oldest is not None and total:
        blocks += _keep(_block(oldest, "case_list", view="case_list", title="Oldest open cases"))
    elif listed is not None and total and _num(listed.obs.get("count")):
        blocks += _keep(_block(listed, "case_list", view="case_list", title="Matching cases"))
    follow: list[str] = []
    filters = _filters_of(o)
    if not total:
        _hint, follow = _zero_suggestions(o)
    elif o.get("bucket") and not o.get("group_by"):
        follow = ["Break the same cases down by severity"]
        if filters.get("status_group") == "active":
            follow.append("Show the open cases by month as a table")
    else:
        # The same cases over the same window, by a bucket that suits its length (the
        # engine adds the period comparison when one is measurable).
        follow = [_rebucket_chip(ask, o, view)]
    follow = [f for f in follow if f] + _follow_ups(view, "cases", charts=bool(blocks))
    return Final(body=body, blocks=blocks[:6], follow_ups=list(dict.fromkeys(follow))[:3])


def _rebucket_chip(ask: Ask, o: Mapping[str, Any], view: PromptView | None = None) -> str:
    """"Show these cases in the last 7 days by day": the breakdown's own window, by a
    bucket that suits its length (an hour up to two days, a day up to 45 days, a week
    up to four months, else a month). A window from a clock time ("since 16 Oct 2026
    22:19", a catch-up card's, at most 7 days back) has no length in hours: by hour
    when it started yesterday or today (when this turn's clock anchor dates today),
    else by day; never by month."""
    hours = ask.win.hours if ask.win is not None and not ask.win.all_time else None
    start = _clock_start(ask.win)
    if hours is None and start is not None:
        today = _clock_today(view) if view is not None else None
        bucket = "hour" if today is not None and (today - start).days <= 1 else "day"
    else:
        bucket = ("hour" if hours and hours <= 48 else "day" if hours and hours <= 45 * 24 else
                  "week" if hours and hours <= 120 * 24 else "month")
    window = re.sub(r"\s*\([^()]*\)\s*$", "", _window(o)).strip()
    return f"Show these cases {_in(window)} by {bucket}" if window else f"Show these cases by {bucket}"


def _clock_start(win: Win | None) -> date | None:
    """The date a "since {date} {time}" window starts on (a ``from`` with a time of day
    and no end), else None."""
    spec = win.spec if win is not None else None
    if not isinstance(spec, Mapping) or set(spec) != {"from"} or not isinstance(spec.get("from"), str):
        return None
    match = re.fullmatch(r"(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(?::\d{2})?", spec["from"])
    if not match:
        return None
    try:
        return date(int(match.group(1)), int(match.group(2)), int(match.group(3)))
    except ValueError:
        return None


def _default_window_sentence(ask: Ask, covered: str, *, what: str = "this covers", tail: str = "") -> str:
    """Why the answer covers its default window: no period was named, the named one
    could not be dated (the anchor lookup did not answer), or a time phrase could not
    be read. Never claims "no period was named" when one was."""
    if ask.undated:
        return (f"{ask.undated} could not be dated (the lookup that reads the current month did not answer), so "
                f"{what} {covered}.{tail}")
    unread = ask.unread or _loose_period(ask.question, ask.lowered)
    if unread:
        return f"I could not read “{_plain(unread, 60)}” as a period, so {what} {covered}.{tail}"
    return f"No period was named, so {what} {covered}.{tail}"


def _loose_period(question: str, lowered: str) -> str | None:
    """A period word the question uses that no rule read ("the weekend", "last night",
    "on Tuesday"), so the default-window sentence never says that no period was named
    when one was. Searched values and entity names are masked first (a host
    "jan-laptop" is never a month); a bucket or a duration is not a period."""
    try:
        text = _window_text(question, lowered)
    except Exception:  # noqa: BLE001 -- advisory wording only
        text = lowered
    for match in _LOOSE_PERIOD_RE.finditer(text):
        if re.search(r"\b(?:day|days|time|times|hour|hours|week|weeks|month|months)\s+$", text[:match.start()]):
            continue  # "day of the week", "busiest day in the month": a bucket
        return match.group(0).strip(" ,.;")
    return None


def _final_summary(view: PromptView, ask: Ask) -> Final | None:
    """A period summary: how many cases (and their severity), the volume per period,
    the posture figures and the riskiest true positives of that window."""
    sev = view.ok("case_stats", where=lambda r: "severity" in (r.obs.get("group_by") or []))
    vol = view.ok("case_stats", where=lambda r: bool(r.obs.get("bucket")))
    post, tps = view.ok("soc_metrics", "posture"), view.ok("search_cases")
    head = sev or vol
    if head is None and post is None:
        return None
    body: list[str] = []
    window = _window((head or post).obs, "")  # type: ignore[union-attr]
    if head is not None and not _num(head.obs.get("total")):
        # Nothing was opened: the rates and lists would only repeat "not measured".
        hint, follow = _zero_suggestions(head.obs)
        body = [f"No case was opened {_in(window)}." + (f" {hint}" if hint else "")]
        return Final(body=body, follow_ups=follow or ["Show the same for all time"])
    if head is not None:
        body.append(_stats_lead(head.obs) + ".")
        groups = _say_group_counts(sev.obs) if sev is not None else ""
        if groups:
            body.append(groups)
    if vol is not None and _num(vol.obs.get("total")):
        # A bucketed window covers whole periods: name it when it differs.
        over = _window(vol.obs, "")
        over = f" {_in(over)}" if over and over != window else ""
        sentence = _say_bucket_counts(vol.obs, unit_word=f"Opened per {vol.obs.get('bucket') or 'period'}{over}")
        if sentence:
            body.append(sentence)
    if post is not None:
        # The false-positive rate is the summary's second figure; the other rates in
        # words (T15: the posture block beside it shows the figures).
        quality = post.obs.get("quality") if isinstance(post.obs.get("quality"), Mapping) else {}
        fp, auto = _num(quality.get("false_positive_rate")), _num(quality.get("automation_rate"))
        if fp is not None:
            body.append(f"False-positive rate **{_pct(fp, ratio=True)}** {_in(_window(post.obs))}"
                        + (", and the AI closed almost all of the closed cases." if auto is not None and auto >= 0.8
                           else ", and the AI closed most of the closed cases." if auto is not None and auto >= 0.5
                           else ", and analysts closed most of the closed cases." if auto is not None else "."))
        else:
            words = _quality_words(post.obs)
            if words:
                body.append(words)
    if tps is not None:
        body.append(_say_search_cases(tps, noun="true positive"))
        body.extend(_case_bullets(tps))
    blocks = _keep(
        _block(vol, "series", view="bar", title="Cases opened"),
        _block(sev, "categories", view=_first_view(sev, "categories", ("donut", "hbar")), title="Cases by severity"),
        _block(post, "kpis", view="kpi_group", title=f"Security posture ({window.split(' (')[0]})" if window
               else "Security posture"),
        _block(tps, "case_list", view="case_list", title="Riskiest true positives") if tps and _num(
            tps.obs.get("count")) else None,
    )
    period = ask.win.phrase if ask.win is not None and ask.win.spec is not None else "this month"
    if ask.win is not None and ask.win.all_time:
        # All time has no period before it to compare with.
        follow = ["Compare this month with last month", "Create a report of lifetime performance",
                  "Which hosts generated the most alerts this week?"]
    else:
        follow = [f"Compare {period} with the period before" if period != "this month"
                  else "Compare this month with last month",
                  f"Create a report for {period}", "Which hosts generated the most alerts this week?"]
    return Final(body=body, blocks=blocks, follow_ups=follow)


def _final_rate(view: PromptView, ask: Ask) -> Final | None:
    """"True-positive rate **13.3%** in Q4 2026, over 45 cases." (the rate asked for
    leads; the AI verdict split, the false-positive rate and the automation rate
    follow)."""
    stats = view.ok("case_stats")
    if stats is None:
        return None
    o = stats.obs
    total = _num(o.get("total")) or 0
    window = _window(o, "all time")
    if not total:
        hint, follow = _zero_suggestions(o)
        return Final(body=[f"True-positive rate: not measured {_in(window)}, where no case was opened."
                           + (f" {hint}" if hint else "")], follow_ups=follow or ["Show the same for all time"])
    totals = o.get("totals") if isinstance(o.get("totals"), Mapping) else {}
    units = o.get("units") if isinstance(o.get("units"), Mapping) else {}
    if _num(totals.get("tp_rate")) is None:
        body = [f"True-positive rate: not measured {_in(window)}, where none of the {_plural(total, 'case')} has an "
                "AI verdict yet."]
    else:
        body = [f"True-positive rate **{_value_text(totals.get('tp_rate'), units.get('tp_rate'))}** {_in(window)}, "
                f"over {_plural(total, 'case')}."]
    groups = _say_group_counts(o)
    if groups:
        body.append(groups.replace("By verdict:", "By AI verdict:", 1))
    parts = [f"false-positive rate {_value_text(totals.get('fp_rate'), units.get('fp_rate'))}"]
    automation = _automation_rate(totals.get("auto_closed"), totals.get("human_closed"))
    if automation is not None:
        closed = (_num(totals.get("auto_closed")) or 0) + (_num(totals.get("human_closed")) or 0)
        parts.append(f"automation rate {_pct(automation)} ({_count(totals.get('auto_closed'))} of "
                     f"{_count(closed)} closed cases closed by the AI agent)")
    body.append(_sentence(_join(parts)))
    body.append("Both rates are shares of the cases with an AI verdict; cases closed by an analyst policy have none.")
    if not (ask.win and ask.win.spec is not None) and not view.analyst_window:
        covered = f"the {window}" if window.startswith("last ") else window
        body.append(_default_window_sentence(ask, covered, tail=" Name another (this month, last quarter, all "
                                                                "time) to change it."))
    return Final(body=body, blocks=_keep(_block(stats, "categories", view=_first_view(
        stats, "categories", ("donut", "hbar")), title="Cases by AI verdict")),
                 follow_ups=["Show the true-positive rate trend by month", "Compare this month with last month",
                             "Summarise today's true positives"])


def _final_entity_cases(view: PromptView, ask: Ask) -> Final | None:
    """Exact case counts for the users, hosts or IPs on the highest-risk cases (cases
    are not grouped by entity, so the answer says who the ranking can and cannot
    include)."""
    found = view.ok("search_cases")
    if found is None:
        return None
    o = found.obs
    kind = ask.field if ask.field in ("user", "host", "ip") else "user"
    noun = {"user": "user", "host": "host", "ip": "IP"}[kind]
    count = int(_num(o.get("count")) or 0)
    if not count:
        return Final(body=[_say_search_cases(found)], follow_ups=_zero_suggestions(o)[1] or [
            "Show the same for all time"])
    listed = len([c for c in o.get("cases") or [] if isinstance(c, Mapping)])
    window = o.get("window") if isinstance(o.get("window"), str) else "all time"
    when = _in(display_text(window, 60))
    pool = (f"all {_plural(count, 'case')}" if listed >= count
            else f"the {listed} highest-risk of {_plural(count, 'case')}")
    counted = []
    for r in view.results():
        value = _dig(r.obs, "filters", "entity") if r.tool == "case_stats" and r.ok else None
        if isinstance(value, str) and value.strip():
            counted.append((value, int(_num(r.obs.get("total")) or 0)))
    if not counted:
        body = [f"None of {pool} {when} is recorded against {'an' if noun == 'IP' else 'a'} {noun}; each case is "
                "recorded against one main entity (an IP, a host or a user)."]
    else:
        ranked = sorted(counted, key=lambda kv: (-kv[1], kv[0].lower()))
        top_count = ranked[0][1]
        leaders = [_code(value) for value, n in ranked if n == top_count]
        each = " each" if len(leaders) > 1 else ""
        verb = "have" if len(leaders) > 1 else "has"
        body = [f"Of the {_plural_noun(noun)} on {pool} {when}, {_join(leaders)} {verb} the most cases: "
                f"**{_count(top_count)}**{each} (exact)."]
        body.extend(f"- {_code(value)}: {_plural(n, 'case')}" for value, n in ranked)
    article = "an" if noun == "IP" else "a"
    body.append(f"Cases are not grouped by {noun}, so {article} {noun} that appears only on lower-risk cases is not "
                "ranked here. To count cases by the analyst they are assigned to, ask for cases by assignee.")
    return Final(body=body, blocks=_keep(_block(found, "case_list", view="case_list", title="Highest-risk cases")),
                 follow_ups=["Open cases by assignee",
                             f"Which {_plural_noun(noun)} generated the most events this week?",
                             "Compare this month with last month"])


_TREND_WORDS = {"timing": "Response times", "rates": "False-positive and true-positive rates",
                "risk": "Average risk", "alerts": "Alert and case volume", "cases": "Case volume",
                "automation": "Automation rate"}


def _automation_rate(auto: Any, human: Any) -> float | None:
    """Closed by the AI agent ÷ closed (by the agent or an analyst), as a percentage."""
    a, h = _num(auto), _num(human)
    if a is None or h is None or a + h <= 0:
        return None
    return round(100.0 * a / (a + h), 1)


def _say_bucket_automation(o: Mapping[str, Any]) -> str:
    """The automation rate per bucket: "Automation rate per month: latest Oct 2026 (in
    progress) 86.8% (33 of 38 closed); lowest Aug 2026 53.3% (8 of 15 closed)"."""
    buckets = [b for b in o.get("buckets") or [] if isinstance(b, Mapping)]
    by_label = {str(g.get("bucket")): g.get("metrics") for g in _stats_groups(o)
                if g.get("bucket") is not None and isinstance(g.get("metrics"), Mapping)}
    points = []
    for b in buckets:
        metrics = by_label.get(str(b.get("label"))) or {}
        auto, human = _num(metrics.get("auto_closed")), _num(metrics.get("human_closed"))
        rate = _automation_rate(auto, human)
        label = display_text(b.get("label"), 40) + (" (in progress)" if b.get("in_progress") else "")
        points.append((label, rate, auto, human))
    measured = [p for p in points if p[1] is not None]
    unit = o.get("bucket") or "period"
    if not measured:
        return f"Automation rate per {unit}: no case was closed in any {unit} of this window."

    def said(p: tuple[str, float | None, float | None, float | None]) -> str:
        return f"{p[0]} {_pct(p[1])} ({_count(p[2])} of {_count((p[2] or 0) + (p[3] or 0))} closed)"

    latest = measured[-1]
    lowest = min(measured, key=lambda p: p[1])  # type: ignore[arg-type,return-value]
    text = f"Automation rate per {unit}: latest {said(latest)}"
    # Periods at the same lowest rate (as written) are all named, never one (PB5).
    lows = [p for p in measured if _pct(p[1]) == _pct(lowest[1])]
    if len(lows) > 1:
        text += f"; lowest {_pct(lowest[1])} in {_peers([p[0] for p in lows], limit=4)}"
    elif lowest is not latest:
        text += f"; lowest {said(lowest)}"
    return text + f" ({len(measured)} of {len(points)} periods measured)."


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
    # Periods at the same highest value (as written) are all named, never one (PB5).
    highs = [p for p in measured if _value_text(p[1], unit) == _value_text(best[1], unit)]
    high = (f"highest {best[0]} {_value_text(best[1], unit)}" if len(highs) == 1
            else f"highest {_value_text(best[1], unit)} in {_peers([p[0] for p in highs], limit=4)}")
    text = f"{name} per {o.get('bucket') or 'period'}: latest {latest[0]} {_value_text(latest[1], unit)}; {high}"
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
    if subject == "timing" and stats is not None:
        o = stats.obs
        body.insert(0, f"**{_TREND_WORDS['timing']} {_in(window)}**, by {o.get('bucket') or 'period'} "
                       f"({_plural(o.get('total'), 'case')}, exact):")
        for metric, name in (("mttr_p50", "MTTR median"), ("mtta_p50", "MTTA median"), ("mttd_p50", "MTTD median")):
            body.append(f"- {_say_bucket_metric(o, metric, name)}")
        if timing is not None:
            body.append(_say_timing(timing))
    elif subject == "automation" and stats is not None:
        o = stats.obs
        filters = _filters_of(o)
        named = {k: v for k, v in filters.items() if k not in ("status", "status_group")}
        body.insert(0, f"**{_TREND_WORDS['automation']} {_in(window)}**, by {o.get('bucket') or 'period'} "
                       f"({_plural(o.get('total'), _case_noun(named, 'case'))}{_entity_about(filters)}, exact): the "
                       f"share of {_case_noun({**named, 'status_group': 'terminal'}, 'case')}s the AI agent closed.")
        body.append(f"- {_say_bucket_automation(o)}")
        totals = o.get("totals") if isinstance(o.get("totals"), Mapping) else {}
        overall = _automation_rate(totals.get("auto_closed"), totals.get("human_closed"))
        if overall is not None:
            body.append(f"Over the whole window: **{_pct(overall)}** ({_count(totals.get('auto_closed'))} closed "
                        f"automatically, {_count(totals.get('human_closed'))} by an analyst).")
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
            groups = _say_group_counts(stats.obs) or _say_bucketed_group_totals(stats.obs)
            if sentence:
                body.append(sentence)
            if groups:
                body.append(groups)
            elif stats.obs.get("group_by"):
                body.append(f"By severity, the cases are split as the stacked chart shows ({_plural(stats.obs.get('total'), 'case')}).")
        if logs is not None:
            body.append("Alert volume: " + _say_log_stats(logs, subject=""))
    if not (ask.win and ask.win.spec is not None) and not view.analyst_window:
        covered = f"the {window}" if window.startswith("last ") else window
        body.append(_default_window_sentence(ask, covered, tail=" Name another (all time, this quarter, the last "
                                                                "6 months) to change it."))
    blocks = _keep(
        # The automation trend: closed automatically against closed by an analyst, per period.
        _block_titled(stats, "series", "counts", view="stacked_bar",
                      title="Closed automatically and by an analyst") if subject == "automation" else None,
        _block_titled(stats, "series", "response times", view="line"),
        _block_titled(stats, "series", "rates", view="line"),
        _block_titled(stats, "series", "average risk", view="line"),
        _block(trends, "series", view="line", title="Cases opened and closed"),
        _block_titled(trends, "series", "alerts", view="bar"),
        _block(stats, "series", view="stacked_bar" if stats and stats.obs.get("group_by") else "bar")
        if subject in ("cases", "alerts", "automation") else None,
        _block_titled(logs, "series", view="line"),
        _block(timing, "kpis", view="kpi_group"),
    )
    follow = ["Compare this month with last month", "Show the same trend for the last 6 months by month"]
    return Final(body=body, blocks=blocks[:6], follow_ups=(follow + _follow_ups(view, "posture", charts=True))[:3])


#: "Is our FP rate better or worse?": the measure the question names, the comparison
#: row that carries it, and which direction is the better one.
_DIRECTION_MEASURES = (
    (r"\b(?:fp|false[- ]positive) rate\b", ("false-positive rate",), "lower"),
    (r"\bmttr\b|\btime to resolve\b|\bresolution time\b", ("mttr (median)", "mttr"), "lower"),
    (r"\bmtta\b|\btime to acknowledge\b", ("mtta (median)", "mtta"), "lower"),
    (r"\bmttd\b|\btime to detect\b", ("mttd (median)", "mttd"), "lower"),
    (r"\bautomation\b|\bauto[- ]?clos\w*", ("automation rate",), "higher"),
    # Volume has no better direction: it went up or down.
    (r"\b(?:case )?volume\b|\bcase count\b|\bnumber of cases\b|\bhow many cases\b", ("cases",), ""),
)
_BETTER_WORSE_RE = re.compile(r"\b(better|worse|improv\w*|getting|declin\w*|regress\w*|chang\w*)\b")


def _direction_answer(ask: Ask, comps: Sequence[Mapping[str, Any] | None], *, named: Iterable[str] = ()) -> str:
    """"**Worse**: the false-positive rate went from 40% to 75.6% (+35.6 points)." when
    the question asks whether a named measure got better or worse; "" otherwise. A
    period in ``named`` (the headline that follows states it with its dates) is named
    plainly: "the false-positive rate was not measured in the previous 90 days"."""
    said = {display_text(n, _PERIOD_CHARS) for n in named if isinstance(n, str)}
    if not _BETTER_WORSE_RE.search(ask.lowered):
        return ""
    for pattern, labels, better in _DIRECTION_MEASURES:
        if not re.search(pattern, ask.lowered):
            continue
        for comp in comps:
            for row in (comp or {}).get("rows") or []:
                if not isinstance(row, Mapping) or display_text(row.get("label"), 60).lower() not in labels:
                    continue
                values = row.get("values") if isinstance(row.get("values"), list) else []
                name = display_text(row.get("label"), 60).split(" (")[0]
                name = name if name.isupper() else name[:1].lower() + name[1:]
                change = _num(row.get("change"))
                if len(values) < 2 or change is None or _num(values[-2]) is None:
                    baseline = display_text(comp.get("baseline"), _PERIOD_CHARS)  # type: ignore[union-attr]
                    if baseline in said:
                        baseline = _period_plain(baseline, display_text(comp.get("subject"), _PERIOD_CHARS))  # type: ignore[union-attr]
                    return (f"There is no direction to report: the {name} was not measured "
                            f"{_in(_the(baseline or 'the earlier period'))}.")
                unit = row.get("unit")
                if change == 0:
                    verdict = "No change"
                elif not better:
                    verdict = "Up" if change > 0 else "Down"
                else:
                    verdict = "Better" if (change < 0) == (better == "lower") else "Worse"
                caveat = " The sample is small, so read the change with care." if row.get("small_sample") else ""
                the = "the " if better else "the number of "
                return (f"**{verdict}**: {the}{name} went from {_value_text(values[-2], unit)} to "
                        f"{_value_text(values[-1], unit)} ({_change_text(row)}).{caveat}")
    return ""


#: The comparison rows a question can name, by the words it uses (T15 order).
_ROW_CUES: tuple[tuple[str, str], ...] = (
    (r"\b(?:fp|false[- ]positives?)\b", r"^false-positive rate"),
    (r"\b(?:tp|true[- ]positives?)\b", r"^true-positive rate"),
    (r"\bmttr\b|\bresol\w+", r"^mttr"),
    (r"\bmtta\b|\backnowledg\w+", r"^mtta"),
    (r"\bmttd\b", r"^mttd"),
    (r"\bauto[- ]?clos\w*|\bautomation\b", r"^auto"),
    (r"\bcases?\b|\bvolume\b|\bcounts?\b", r"\bcases\b"),
)


def _named_rows(ask: Ask) -> list[str]:
    """The row-label patterns of the measures the question names, in its order."""
    named = sorted(((m.start(), label) for cue, label in _ROW_CUES for m in [re.search(cue, ask.lowered)] if m),
                   key=lambda pair: pair[0])
    return [label for _at, label in named]


def _pick_rows(rows: Sequence[Mapping[str, Any]], labels: Sequence[str]) -> list[Mapping[str, Any]]:
    picked: list[Mapping[str, Any]] = []
    for label in labels:
        for row in rows:
            if row not in picked and re.search(label, display_text(row.get("label"), 60).lower()):
                picked.append(row)
                break
    return picked


def _top_rows(comp: Mapping[str, Any], ask: Ask, limit: int = 2) -> Mapping[str, Any]:
    """``comp`` with at most ``limit`` rows: the measures the question names (in its
    order), never one it did not ask for in their place (the count row only when it
    names none of these); a question that names no measure, or only the cases ("Compare
    cases this month with last month"), gets the count row and the next one."""
    rows = [r for r in comp.get("rows") or [] if isinstance(r, Mapping)]
    named = _named_rows(ask)
    if any(label != r"\bcases\b" for label in named):
        picked = _pick_rows(rows, named) or _pick_rows(rows, [r"\bcases\b"])
    else:
        picked = _pick_rows(rows, [r"\bcases\b"])
        picked += [r for r in rows if r not in picked]
    return {**comp, "rows": picked[:limit]}


def _subject_when(comp: Mapping[str, Any]) -> str:
    """"now" for a comparison whose subject is the current, in-progress period, else
    "in Sep 2026" (a comparison of two past periods never calls the later one "now")."""
    periods = [display_text(p, _PERIOD_CHARS) for p in comp.get("periods") or [] if isinstance(p, str)]
    flags = comp.get("in_progress") if isinstance(comp.get("in_progress"), list) else []
    subject = display_text(comp.get("subject"), _PERIOD_CHARS) or (periods[-1] if periods else "")
    at = periods.index(subject) if subject in periods else len(periods) - 1
    if 0 <= at < len(flags) and flags[at] is True:
        return "now"
    return _in(subject) if subject else "now"


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
    measured = comp  # the tool's own rows (labels unchanged) for the direction answer
    stats_obs = (head or mix).obs if (head or mix) is not None else {}  # type: ignore[union-attr]
    filters = _filters_of(stats_obs)
    filters = {k: v for k, v in filters.items() if v not in (None, "", [])}
    named: tuple[str, ...] = ()  # the periods the headline names with their dates
    if comp:
        subject = display_text(comp.get("subject"), _PERIOD_CHARS)
        baseline = display_text(comp.get("baseline"), _PERIOD_CHARS)
        named = (subject, baseline)
        if filters:
            # Every filter is named, in the headline and on the count row, so a filtered
            # count never reads as the case volume (SPEC: name every filter).
            noun = _plural_noun(_case_noun(filters, "case")) + _entity_about(filters)
            noun = noun[:1].upper() + noun[1:]
            body.append(f"**{noun}, {subject} compared with {_the(baseline)}**. Changes are computed exactly:")
            comp = _relabel_count(comp, filters)
        else:
            headline = f"{subject} compared with {_the(baseline)}"
            # The method is its own sentence: a period name that ends in its dates in
            # brackets is never followed by a second bracket.
            body.append(f"**{headline[:1].upper()}{headline[1:]}**. Changes are computed exactly over every case:")
        # The headline named both periods with their dates: the rows name them plainly.
        # Two rows, the ones the question names first (T15: the comparison block shows
        # every row).
        comp = _top_rows(comp, ask)
        body.extend(f"- {line}" for line in _say_comparison(comp, limit=2, with_note=False, stated=named))
        note = comp.get("note")
        if isinstance(note, str) and note.strip():
            body.append(_note_text(note))
    elif head is not None:
        body.extend(_say_case_stats(head))
    post_comp = _comparison_of(post.obs) if post is not None and not filters else None
    if post_comp and (not comp or re.search(r"\bautomat\w*|\bauto[- ]?clos\w*", ask.lowered)):
        # Only when the question asks for it, or without the case comparison's two rows:
        # the posture block beside the prose shows the automation rate too, and the
        # prose names at most two of its figures (T15).
        rows = [r for r in post_comp.get("rows") or [] if isinstance(r, Mapping)]
        auto = next((r for r in rows if r.get("label") == "Automation rate"), None)
        if auto is not None:
            body.append(f"Automation rate: {_change_text(auto)} "
                        f"({_value_text((auto.get('values') or [None])[-1], 'percent')} {_subject_when(post_comp)}).")
    if mix is not None and _comparison_of(mix.obs):
        lines = _say_comparison(_comparison_of(mix.obs), limit=4, with_note=False,  # type: ignore[arg-type]
                                stated=named)
        if lines:
            body.append(f"By {display_text((mix.obs.get('group_by') or ['severity'])[0], 30).replace('_', ' ')}:")
            body.extend(f"- {line}" for line in lines)
    timing_comp = _comparison_of(timing.obs) if timing is not None else None
    if timing_comp:
        # The rows stated above are not stated again; the response times the question
        # names are (MTTR asked beside cases and the FP rate), in its order, and never an
        # unasked one in their place. "Response times" named in general states two.
        said = [str(r.get("label")) for r in (comp or {}).get("rows") or [] if isinstance(r, Mapping)]
        timing_rows = [r for r in timing_comp.get("rows") or [] if isinstance(r, Mapping)
                       and str(r.get("label")) not in said]
        wanted = [p for p in _named_rows(ask) if p.startswith("^mtt")]
        if wanted:
            timing_rows = _pick_rows(timing_rows, wanted)
        # T15: a figure the key-figures blocks above also show is not stated once the
        # prose named two of theirs; an asked one is pointed to instead.
        crowded = {str(r.get("label")) for c in (measured, post_comp) if c for r in c.get("rows") or []
                   if isinstance(r, Mapping)} if len(said) >= 2 else set()
        stated_rows = [r for r in timing_rows if str(r.get("label")) not in crowded]
        pointed = [display_text(r.get("label"), 40) for r in timing_rows
                   if str(r.get("label")) in crowded] if wanted else []
        lines = _say_comparison({**timing_comp, "rows": stated_rows}, limit=2,
                                with_note=False, stated=named) if stated_rows else []
        if lines:
            body.append("Response times: " + " ".join(lines))
        if pointed:
            body.append(f"{_join(pointed)} {'is' if len(pointed) == 1 else 'are'} in the figures below, "
                        "with the change.")
    direction = _direction_answer(ask, [measured, post_comp, _comparison_of(timing.obs) if timing else None],
                                  named=named)
    if direction:
        body.insert(0, direction)
    split = display_text((mix.obs.get("group_by") or ["severity"])[0], 30).replace("_", " ") if mix else "severity"
    filtered_noun = ""
    if filters and _case_noun(filters, "case") != "case":
        # "Critical cases versus the previous period" (an entity is named in the prose
        # only: block titles carry engine words).
        filtered_noun = _plural_noun(_case_noun(filters, "case"))
        filtered_noun = filtered_noun[:1].upper() + filtered_noun[1:]
    blocks = _keep(
        _block_titled(head, "comparison", view="kpi_group",
                      title=f"{filtered_noun} versus the previous period" if filtered_noun
                      else "Change versus the previous period"),
        _block_titled(mix, "comparison", view="grouped_bar", title=f"By {split}"),
        _block(post, "kpis", view="kpi_group", title="Security posture with changes") if not filters else None,
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
    # The title names the period only ("last 30 days"); the subtitle keeps its dates.
    short = label.split(" (")[0]
    if short.lower() in ("this week", "last week", "today", "yesterday"):
        # A saved report outlives "last week": name the dated period the comparison
        # row resolved it to ("W40 2026"), when the lookup returned one.
        dated = display_text((_comparison_of(vol.obs) or {}).get("subject"), 40) if vol is not None else ""
        if dated:
            short = dated
    title = _perf_title(template, "" if all_time else short, all_time)
    if template == "executive" and re.search(r"\bexec(?:utive)? (?:summary|overview|brief)\b", ask.lowered):
        title = f"Executive summary, {short}" if short and not all_time else "Executive summary"
    p = post.obs if post else {}
    quality = p.get("quality") if isinstance(p.get("quality"), Mapping) else {}
    totals = o.get("totals") if isinstance(o.get("totals"), Mapping) else {}
    cases = _num(o.get("total") if vol else p.get("case_count"))
    fp = totals.get("fp_rate") if vol else (_num(quality.get("false_positive_rate")) or 0) * 100
    automation = quality.get("automation_rate")
    mttr = _dig(p, "lifecycle_minutes", "mttr_minutes", "p50") if post else totals.get("mttr_p50")
    open_now = _dig(p, "open_now", "count")
    # The takeaway (T15): the report's blocks show every figure, so the lead names two
    # (the case count and the false-positive rate) and says the rest in words.
    facts = f"**{_plural(cases, 'case')}**"
    if _num(fp) is not None:
        facts += f" with a false-positive rate of **{_pct(fp)}**"
    detail = label.split(" (", 1)[1].rstrip(")") if " (" in label else ""
    span = (f" ({short}, {detail})" if all_time and detail else f" ({detail})" if detail else "")
    auto = _num(automation)
    automation_words = ("" if auto is None else " The AI closed almost all of the closed cases automatically."
                        if auto >= 0.8 else " The AI closed most of the closed cases automatically." if auto >= 0.5
                        else " Analysts closed most of the closed cases.")
    lead = f"**{title}**{span}: {facts}.{automation_words}"
    summary_bits = [f"{_plural(cases, 'case')} {_in(label) if label else ''}".strip()]
    # The comparison rows whose figure the opening sentence states (from the same
    # lookup): a row the earlier period has no figure for is then named, not restated.
    known = {"cases"} if vol else set()
    if _num(fp) is not None:
        summary_bits.append(f"false-positive rate {_pct(fp)}")
        known |= {"false-positive rate"} if vol else set()
    tp = totals.get("tp_rate") if vol else None
    if _num(tp) is not None:
        summary_bits.append(f"true-positive rate {_pct(tp)}")
        known.add("true-positive rate")
    if _num(automation) is not None:
        summary_bits.append(f"automation rate {_pct(automation, ratio=True)}")
    if _num(mttr) is not None:
        summary_bits.append(f"MTTR median {_minutes(mttr)}")
    if _num(open_now) is not None:
        summary_bits.append(f"{_count(open_now)} open now")
    stages = _stages(noise.obs) if noise else {}
    overall = _dig(noise.obs, "reduction_pct", "overall") if noise else None
    if _num(overall) is not None:
        summary_bits.append(f"{_pct(overall)} noise reduction from {_count(stages.get('ingested'))} alerts")
    comp = _comparison_of(vol.obs) if vol else None
    # Three rows, then the comparison's own note (a window materially shorter than the
    # period before it says the change compares a partial period). The opening sentence
    # already named the window with its dates, so the rows name it plainly.
    change_lines = _say_comparison(comp, limit=3, with_note=False, known=known,
                                   stated=(comp.get("subject"),) if label else ()) if comp else []
    note = comp.get("note") if comp else None
    if change_lines and isinstance(note, str) and note.strip():
        change_lines.append(_note_text(note))
    summary = _sentence(_join(summary_bits)) + (" " + " ".join(c.replace("**", "") for c in change_lines)
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
        # "last week (W40 2026)": the relative label with the dated period it was.
        envelope["subtitle"] = (f"{label} ({short})" if short != label.split(" (")[0] else label)[:200]
    if template == "infographic":
        envelope["layout"] = "infographic"
    body = [lead]
    if comp and re.search(r"\bcompar\w*|\bvs\.?\b|\bversus\b|\bprevious\b", ask.lowered):
        # "Compare this report with the previous 30 days": the change follows the lead,
        # in two rows (T15: the case count and the false-positive rate the lead names,
        # so the prose names no figure the comparison block does not lead with). The
        # lead named the window with its dates, so the rows name it plainly (the
        # previous period keeps its dates, on its first mention), as the Summary does.
        lines = _say_comparison(comp, limit=2, bullets=True, stated=(comp.get("subject"),) if label else ())
        if lines:
            body = [f"**{title}**{span}: {facts}.", "Compared with the previous period:", *lines]
    if not (ask.win and ask.win.spec is not None) and not view.analyst_window:
        body.append(_default_window_sentence(ask, "the last 30 days", what="the report covers",
                                             tail=" Ask for a lifetime report to cover all time."))
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
    named = _code(ask.case_id) if ask.case_id else "that id"
    body = [f"No case with the id {named} was found: it does not exist, or it is outside what you can see. "
            "Check the id, or find the case by searching for words from its title."]
    follow = ["List the open cases", "Which cases were escalated this week?", "Show the newest escalated case"]
    return Final(body=body, follow_ups=follow, narrated={r.ordinal for r in view.failed()})


def _final_brief(view: PromptView, ask: Ask) -> Final | None:
    missing = _case_missing(view, ask)
    if missing is not None:
        return missing
    got, decision = view.ok("get_case"), view.ok("explain_decision")
    found = view.ok("search_cases")
    if got is None and not ask.case_id and found is not None and not _newest_case(found):
        status = (ask.case_status or "escalated").replace("_", " ")
        return Final(body=[f"No {status} case was found to brief. Name a case id, or ask for the open cases first."],
                     follow_ups=["List the open cases", "Show me the newest escalated case",
                                 "Which cases were escalated this week?"])
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
    handle = display_text(case.get("case_number"), 60) or case_id
    title = f"Investigation brief: {handle}" if handle else "Investigation brief"
    envelope = {"type": "report", "title": title[:120], "template": "investigation_brief", "sections": sections,
                "subtitle": "Advisory · the case decision is made by policy"}
    name = _case_name(case)
    typed = _asked_by_id(case, ask) if case else ""
    if typed:
        # The internal id the analyst typed, once, beside the number shown.
        name = f"{_code(typed)}, {name}" if name else _code(typed)
    lead = [f"**Investigation brief for {_case_ref(case) if case else _code(case_id)}**" + (f" ({name})" if name else "")
            if not case or _numbered(case) or not name else f"**Investigation brief for {name}** ({_case_ref(case)})"
            + f": the case {_case_facts(case)}, status **{status}**; confidence in the verdict is {confidence}.",
            "The brief is advisory: the case decision is made by the deterministic policy, not by this brief."]
    action = _plain(_dig(case, "recommended_action"), _NARRATED_CHARS)
    body = lead + ([f"Recorded recommendation: {action}"] if action else [])
    return Final(body=body, blocks=[envelope], follow_ups=["Why was this case decided this way?",
                                                           "Show the other cases for the same entity",
                                                           "Investigate the newest escalated case"],
                 lead=body, closing=_REPORT_READY)


def _campaigns_involving(camps: Result, value: str, cases: Result | None) -> list[Mapping[str, Any]]:
    """The listed campaigns that involve ``value``: it is one of their shared entities,
    one of their cases is a case the entity search found, or the lookup itself listed
    the campaigns involving ``value`` and says how each one does (``match``)."""
    wanted = value.strip().lower()
    filtered = str(camps.input.get("entity") or "").strip().lower() == wanted
    case_ids = {str(c.get("case_id")) for c in (cases.obs.get("cases") if cases else None) or []
                if isinstance(c, Mapping) and c.get("case_id")}
    out = []
    for camp in camps.obs.get("campaigns") or []:
        if not isinstance(camp, Mapping):
            continue
        entities = [str(e).split(":", 1)[-1].strip().lower() for e in camp.get("entities") or [] if isinstance(e, str)]
        ids = {str(i) for i in camp.get("case_ids") or [] if isinstance(i, str)}
        vouched = filtered and camp.get("match") in ("shared_entity", "member_case")
        if wanted in entities or ids & case_ids or vouched:
            out.append(camp)
    return out


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
        if group not in ("user", "host", "ip", "rule") or not _num(r.obs.get("total")):
            # Zero matches: the event search below says so once.
            continue
        sentence = _say_log_stats(r, subject=f"for {_code(value)}")
        if said_total:
            # The total is the same for every grouping: say it once, then each ranking
            # ("By rule, …"). The ranking clause starts at "; by ": a window label with
            # its dates ("(since 24 Sep 2026; 5 of 5 sources answered)") has its own "; ".
            _total, by, ranking = sentence.partition("; by ")
            sentence = f"By {ranking}" if by else ""
        if sentence:
            body.append(f"- {sentence}")
            said_total = True
    logs = view.ok("search_logs")
    if logs is not None and not said_total:
        # The rankings above already gave the total and who/what it involves.
        body.append(_say_search_logs(logs, subject=_code(value)))
    cases = view.ok("search_cases")
    stats = view.ok("case_stats")
    if stats is not None:
        body.extend(_say_case_stats(stats)[:2])
    elif cases is not None:
        body.append(_say_search_cases(cases))
    got = view.ok("get_case")
    if got is not None:
        # The case read is the first of the risk-ranked related cases; others at the same
        # risk are named so it never reads as the only riskiest one (PB5).
        related = view.ok("search_cases", where=lambda r: bool(_dig(r.obs, "filters", "entity")))
        rows = [c for c in (related.obs.get("cases") if related else None) or [] if isinstance(c, Mapping)]
        read = next((c for c in rows if c.get("case_id") == _dig(got.obs, "case", "case_id")), None)
        tied = _risk_ties(rows, read) if read is not None else []
        head = (f"One of the riskiest related cases (tied at risk {_shown_risk(read)} with "
                f"{_peers([_case_ref(c) for c in tied])}): " if tied and read is not None
                else "Riskiest related case: ")
        body.append(head + " ".join(_say_get_case(got)[:2]))
        decision = view.ok("explain_decision")
        if decision is not None:
            sentence = _say_decision(decision)
            if sentence:
                body.append(sentence)
    mitre = view.ok("mitre_lookup")
    if mitre is not None:
        body.extend(_say_mitre(mitre)[:2])
    camps = view.ok("list_campaigns")
    involved = _campaigns_involving(camps, value, cases) if camps is not None else []
    # The table shows the campaigns the lookup listed: titled for the entity when each
    # of them involves it (the lookup asked for those), else honestly as every campaign.
    listed_rows = [c for c in (camps.obs.get("campaigns") if camps else None) or [] if isinstance(c, Mapping)]
    only_involved = bool(involved) and len(involved) == len(listed_rows)
    if camps is not None:
        listed = _num(camps.obs.get("total")) or 0
        if involved:
            body.append("Campaigns involving it: " + _say_campaigns(camps, involved))
        elif listed:
            body.append(f"None of the {_plural(listed, 'campaign')} involves {noun} {_code(value)}.")
        elif camps.input.get("entity"):
            body.append(f"No campaign involves {noun} {_code(value)}.")
        else:
            body.append("No campaign is recorded.")
    audit = view.ok("audit_search")
    if audit is not None:
        body.append("Audit trail of that case: " + _say_audit(audit))
    if not (ask.win and ask.win.spec is not None) and not view.analyst_window:
        body.append(_default_window_sentence(ask, "the last 30 days", what="the logs and cases cover"))
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
        _block(camps, "table", view="table", title=f"Campaigns involving this {noun}" if only_involved
               else "All campaigns") if involved else None,
    )
    riskiest = _dig(got.obs, "case") if got is not None else None
    follow = [f"Give me an investigation brief for {display_text(_case_read_ref(riskiest), 60)}"
              if isinstance(riskiest, Mapping) and riskiest.get("case_id") else "Investigate the newest escalated case",
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


# --------------------------------------------------------------------------- #
# Round 13: finals of the console starters (SPEC-chat §3.4, §3.8.7, §3.14, §7.3).
# Each answers the starter's question from the current lookups; a figure the
# suggestion stated that has since moved is said plainly (the counts note), and a
# case the suggestion expected open that has since closed is said first.
# --------------------------------------------------------------------------- #
_TERMINAL_STATUSES = frozenset({"resolved", "closed"})
#: Who decided a case, by ``Case.decision_by`` (``DecisionBy``). Only the AGENT
#: closes under the auto-close policy; SYSTEM is deterministic fail-to-human routing
#: and never closes a case on its own (non-negotiable #3).
_DECIDERS = {"agent": "the AI agent, under the auto-close policy", "system": "deterministic routing",
             "analyst": "an analyst", "analyst_policy": "an analyst's declared-benign rule",
             "automation": "an automation rule"}


def _age_words(minutes: Any) -> str:
    """A duration the way the console words one ("40 min", "3 hours", "2 days")."""
    number = _num(minutes)
    return format_age(number * 60) if number is not None else "an unknown time"


def _counts_moved(said: Any, now: Any, noun: str) -> str:
    """"The suggestion counted 3 cases; there are 5 now." when a starter's count moved
    (SPEC §3.8.4), else ""."""
    said_n, now_n = _num(said), _num(now)
    if said_n is None or now_n is None or said_n == now_n:
        return ""
    return (f"The suggestion counted {_plural(said_n, noun)}; there {'is' if now_n == 1 else 'are'} "
            f"{_count(now_n)} now.")


def _closed_since(case: Mapping[str, Any], ask: Ask) -> str:
    """The lead of a starter about ONE case it expected open, once that case closed."""
    status = str(case.get("status") or "")
    if ask.starter not in _OPEN_CASE_STARTERS or status not in _TERMINAL_STATUSES:
        return ""
    verdict = _verdict_word(case.get("verdict"))
    how = f" as a {verdict}" if verdict in ("true positive", "false positive") else ""
    by = _DECIDERS.get(str(case.get("decision_by") or ""), "")
    rest = {"needs_human": "so it no longer needs a person",
            "my_cases_one": "so there is nothing left to do on it",
            }.get(ask.starter or "", "so its response target no longer applies")
    return (f"{_case_head(case, start=True)} was {status}{how} after this suggestion was made"
            + (f" (decided by {by})" if by else "") + f", {rest}.")


def _final_starter_case(view: PromptView, ask: Ask) -> Final | None:
    """``case`` answers, with what each starter and case chip asks added: what would
    settle a case that needs a person, the next step on your case, what evidence is
    missing, and who closed it and why."""
    final = _final_case(view, ask)
    if final is None or ask.starter is None:
        return final
    got = view.ok("get_case")
    case = _dig(got.obs, "case") if got else None
    if not isinstance(case, Mapping) or not case:
        return final
    status = str(case.get("status") or "")
    terminal = status in _TERMINAL_STATUSES
    verdict = str(case.get("verdict") or "").upper()
    closed = _closed_since(case, ask)
    if closed:
        final.body.insert(0, closed)
        final.lead = [closed, *final.lead]
        return final
    extra = ""
    if ask.starter in ("needs_human", "case_needs_person") and not terminal:
        extra = ("What would settle it: an analyst's verdict. The policy will not close this case on its own, so "
                 "confirm it as a true or false positive, or escalate it, in Case Manager.")
    elif ask.starter == "my_cases_one" and not terminal:
        mine = _my_cases_lines(view, case)
        if mine:
            final.body.extend(mine)
            # As a report lead: the sentence alone, without the list it introduces.
            final.lead = [*final.lead, mine[0].split(";", 1)[0].rstrip(".") + "."]
        extra = ("Next: check the evidence and activity below, then record a verdict or escalate it in Case "
                 "Manager.")
    elif ask.starter == "case_undecided":
        evidence = _num(case.get("evidence_items"))
        events = _num(case.get("member_events"))
        held = _join([p for p in (_plural(evidence, "evidence item") if evidence is not None else "",
                                  _plural(events, "member event") if events is not None else "") if p])
        if terminal:
            extra = f"This case is already decided: it is {status}."
        elif verdict == "NEEDS_HUMAN" or not verdict:
            extra = ("What is missing: an analyst's verdict. The agent could not decide it with enough confidence"
                     + (f" from the {held} on record" if held else "") + ".")
        else:
            extra = (f"What is missing: an analyst's confirmation. It has a {_verdict_word(verdict)} verdict but is "
                     f"still {status.replace('_', ' ')}" + (f", with {held} on record" if held else "") + ".")
    elif ask.starter == "case_closed_why":
        if terminal and any("under today's policy" in line for line in final.body):
            extra = ""  # the decision sentence already named who closed it
        elif terminal:
            by = _DECIDERS.get(str(case.get("decision_by") or ""), "")
            extra = f"Who decided: {by}." if by else "The record does not say who decided."
        else:
            extra = f"This case is not closed: its status is **{status.replace('_', ' ')}**."
    if extra:
        final.body.append(extra)
        final.lead = [*final.lead, extra]
    return final


def _my_cases_lines(view: PromptView, case: Mapping[str, Any]) -> list[str]:
    """Where ONE case stands among the caller's own open cases (the "my case" starter):
    their only one, one of several (the others listed, highest risk first), or no longer
    theirs. Only the caller's own cases are named (assignee "me")."""
    mine = view.ok("search_cases", where=_is_my_search)
    if mine is None:
        return []
    if _nobody_signed_in(mine):
        return ["No analyst is signed in (sign-in is off), so chat cannot tell whether this case is yours."]
    count = int(_num(mine.obs.get("count")) or 0)
    rows = [c for c in mine.obs.get("cases") or [] if isinstance(c, Mapping)]
    refs = {str(case.get(k)) for k in ("case_id", "case_number") if case.get(k)}

    def same(row: Mapping[str, Any]) -> bool:
        return any(str(row.get(k)) in refs for k in ("case_id", "case_number") if row.get(k))

    others = [r for r in rows if not same(r)]
    if len(others) == len(rows):
        if count > len(rows):
            return []  # past the listed rows: whether it is still yours is not known here
        if not count:
            return ["It is no longer assigned to you, and no open case is assigned to you now."]
        return [f"It is no longer assigned to you; **{_plural(count, 'open case')}** "
                f"{'is' if count == 1 else 'are'} assigned to you now."]
    if count <= 1:
        return ["It is your only open case."]
    shown = others[:4]
    head = f"It is one of your **{_plural(count, 'open case')}**"
    if not shown:
        return [head + "."]
    tail = ("the other one:" if count == 2 and len(shown) == 1
            else "the others, highest risk first:" if count - 1 <= len(shown)
            else f"the {_count(len(shown))} highest-risk of the other {_count(count - 1)}:")
    return [f"{head}; {tail}", *(f"- {_case_line(c)}" for c in shown)]


def _sla_rows(shift: Result | None) -> tuple[dict[str, float], int, int, bool]:
    """``({case_id: overdue minutes}, breached total, about-to-breach total, the
    breached list is complete)`` from a shift snapshot."""
    o = shift.obs if shift else {}
    listed = {str(b.get("case_id")): (_num(b.get("overdue_minutes")) or 0.0)
              for b in _dig(o, "sla", "breached") or [] if isinstance(b, Mapping) and b.get("case_id")}
    totals = _dig(o, "sla", "totals") or {}
    breached = int(_num(_dig(totals, "breached")) or 0)
    close = int(_num(_dig(totals, "about_to_breach")) or 0)
    return listed, breached, close, len(listed) >= breached


def _near_rows(shift: Result | None) -> list[Mapping[str, Any]]:
    """The open cases close to their response target the shift snapshot names, nearest
    first (at most 5; ``sla.totals.about_to_breach`` counts every one)."""
    rows = _dig(shift.obs, "sla", "about_to_breach") if shift else None
    return [r for r in rows or [] if isinstance(r, Mapping) and r.get("case_id")]


def _attention_row(shift: Result | None, case_id: Any) -> Mapping[str, Any] | None:
    for row in (shift.obs.get("attention") if shift else None) or []:
        if isinstance(row, Mapping) and row.get("case_id") == case_id:
            return row
    return None


def _assignee_word(name: Any) -> str:
    """An assignee as narrated: the name as inline code, or "unassigned" for the
    engine's no-assignee labels."""
    text = name.strip() if isinstance(name, str) else ""
    if not text or text.strip("()").lower() in ("unassigned", "none", "nobody"):
        return "unassigned"
    return _code(text)


def _owner(row: Mapping[str, Any]) -> str:
    assignee = row.get("assignee")
    return f"assigned to {_code(assignee)}" if isinstance(assignee, str) and assignee.strip() else "not assigned"


def _final_sla_case(view: PromptView, ask: Ask) -> Final | None:
    missing = _case_missing(view, ask)
    if missing is not None:
        return missing
    got, shift = view.ok("get_case"), view.ok("shift_report")
    case = _dig(got.obs, "case") if got else None
    if not isinstance(case, Mapping) or not case:
        return None
    body: list[str] = []
    closed = _closed_since(case, ask)
    if closed:
        body.append(closed)
    status = str(case.get("status") or "").replace("_", " ")
    head = f"{_case_head(case, start=True)} is **{status}** and {_owner(case)}"
    row = _attention_row(shift, case.get("case_id"))
    if row is not None and _num(row.get("age_minutes")) is not None:
        head += f"; it has been open for {_age_words(row.get('age_minutes'))}"
    body.append(head + ".")
    if shift is not None and not closed:
        listed, breached, close, complete = _sla_rows(shift)
        overdue = listed.get(str(case.get("case_id")))
        near = {str(r.get("case_id")): r for r in _near_rows(shift)}
        mine = near.get(str(case.get("case_id")))
        if not _dig(shift.obs, "sla", "enabled"):
            body.append("Response targets are switched off, so no case is measured against one.")
        elif overdue is not None:
            body.append(f"It is past its response target by {_age_words(overdue)}, one of "
                        f"{_plural(breached, 'case')} past their target.")
        elif mine is not None:
            left = _num(mine.get("minutes_left"))
            body.append("It is close to its response target" + (
                f", with {_age_words(left)} left." if left is not None else "."))
        elif complete:
            if close and close > len(near):
                body.append(f"It is not past its response target, and it is not among the {_count(len(near))} "
                            f"nearest to theirs (of {_plural(close, 'open case')} close to their target), so "
                            "check its priority target in Case Manager.")
            elif close:
                body.append("It is not past its response target, and it is not close to it.")
            else:
                body.append("It is not past its response target.")
        else:
            body.append(f"It is not among the {_plural(len(listed), 'most overdue case')} the shift snapshot names "
                        f"(of {_plural(breached, 'case')} past their target), so check its target in Case Manager.")
    return Final(body=body, blocks=_keep(
        _block(got, "entity", view="entity", title="Case entity"),
        _block(got, "timeline", view="timeline", title="Status history"),
    ), lead=body[:2])


def _final_my_cases(view: PromptView, ask: Ask) -> Final | None:
    cases, stats = view.ok("search_cases"), view.ok("case_stats")
    if cases is None and stats is None:
        return None
    body: list[str] = []
    said = _num(ask.slot("n"))
    if cases is None or _nobody_signed_in(cases):
        # Nobody is signed in (sign-in is off), so "me" names no one: say so first and
        # never present the whole queue as the analyst's own cases.
        body.append("No analyst is signed in (sign-in is off), so chat cannot tell which open cases are yours.")
        groups = _stats_groups(stats.obs) if stats else []
        owners = [(_dig(g, "key", "assignee"), _num(_dig(g, "metrics", "count")) or 0) for g in groups]
        if owners:
            total = _dig(stats.obs, "totals", "count")
            body.append(f"The open queue (**{_plural(total, 'case')}**) by assignee: "
                        + _join([f"{_assignee_word(name)} {_count(n)}" for name, n in owners[:6]]) + ".")
        return Final(body=body, blocks=_keep(
            _block(stats, "categories", view="hbar", title="Open cases by assignee"),
        ))
    count = _num(cases.obs.get("count")) or 0
    if not count:
        body.append("No open case is assigned to you right now.")
    else:
        body.append(f"**{_plural(count, 'open case')}** {'is' if count == 1 else 'are'} assigned to you.")
    moved = _counts_moved(said, count, "open case")
    if moved:
        body.append(moved)
    rows = [c for c in cases.obs.get("cases") or [] if isinstance(c, Mapping)]
    if rows:
        body.append(_highest_risk_lead(rows, "of your open cases") if len(rows) > 1
                    else f"It is {_case_head(rows[0])}.")
        if len(rows) > 1:
            body.append("Your open cases, highest risk first:")
            body.extend(f"- {_case_line(c)}" for c in rows[:5])
    return Final(body=body, blocks=_keep(
        _block(cases, "case_list", view="case_list", title="Your open cases by risk") if rows else None,
    ))


def _final_sla(view: PromptView, ask: Ask) -> Final | None:
    shift = view.ok("shift_report")
    if shift is None:
        return None
    listed, breached, close, _complete = _sla_rows(shift)
    attention = {str(a.get("case_id")): a for a in shift.obs.get("attention") or [] if isinstance(a, Mapping)}
    body: list[str] = []
    if not _dig(shift.obs, "sla", "enabled"):
        body.append("Response targets are switched off, so no case is measured against one.")
        return Final(body=body)
    if ask.starter == "sla_breached":
        if not breached:
            body.append("No open case is past its response target right now.")
        else:
            body.append(f"**{_plural(breached, 'case')}** {'is' if breached == 1 else 'are'} past {'its' if breached == 1 else 'their'} response target right now.")
        unfiltered = ask.slot("unfiltered")
        if isinstance(unfiltered, str) and unfiltered:
            body.append(unfiltered)
        moved = _counts_moved(ask.slot("n"), breached, "case")
        if moved:
            body.append(moved)
        if listed:
            # Exactly the cases listed below (the snapshot names at most five of the
            # total stated above): "the 5 most overdue", never a different count (PB3).
            shown_n = min(len(listed), 5)
            body.append("Most overdue first:" if shown_n >= breached else
                        "The most overdue:" if shown_n == 1 else f"The {_count(shown_n)} most overdue:")
            # The overdue rows carry their number and assignee; the attention queue adds
            # what each case is about when it lists it.
            overdue_rows = {str(b.get("case_id")): b for b in _dig(shift.obs, "sla", "breached") or []
                            if isinstance(b, Mapping)}
            for case_id, overdue in list(listed.items())[:5]:
                own = overdue_rows.get(case_id, {})
                row = {**attention.get(case_id, {"case_id": case_id}),
                       **{k: v for k, v in own.items() if k in ("case_number", "assignee") and v}}
                body.append(f"- {_case_line(row)}, {_owner(row)}, {_age_words(overdue)} over target")
            shown_ids = list(listed)[:5]
            held = [attention[c] for c in shown_ids if c in attention]
            unassigned = sum(1 for r in held if not (isinstance(r.get("assignee"), str) and r.get("assignee").strip()))
            on_hold = sum(1 for r in held if r.get("status") == "on_hold")
            human = sum(1 for r in held if str(r.get("verdict") or "").upper() == "NEEDS_HUMAN")
            causes = [p for p in (
                f"{_count(human)} wait for an analyst's verdict" if human else "",
                f"{_count(on_hold)} {'is' if on_hold == 1 else 'are'} on hold" if on_hold else "",
                f"{_count(unassigned)} {'has' if unassigned == 1 else 'have'} no assignee" if unassigned else "",
            ) if p]
            if causes:
                # "These" are the cases listed above; when the snapshot describes only
                # some of them, the count says which (never a different "these").
                among = (f"among these {_count(len(held))}" if len(held) == len(shown_ids) else
                         f"among the {_count(len(held))} of these the shift snapshot describes")
                body.append(f"What is holding them up, {among}: {_join(causes)}.")
            if view.ok("get_case") is not None:
                body.append("The most overdue case is shown below.")
    else:
        near = _near_rows(shift)
        if not close:
            body.append("No open case is close to its response target right now.")
        else:
            body.append(f"**{_plural(close, 'case')}** {'is' if close == 1 else 'are'} close to {'its' if close == 1 else 'their'} response "
                        "target (most of the response time used).")
        moved = _counts_moved(ask.slot("n"), close, "case")
        if moved:
            body.append(moved)
        if near:
            body.append("Nearest to the target first, with who has each:" if len(near) > 1
                        else "The case, with who has it:")
            for row in near[:5]:
                named = {**(_attention_row(shift, row.get("case_id")) or {}), **{
                    k: v for k, v in row.items() if k in ("case_id", "case_number") and v}}
                left = _num(row.get("minutes_left"))
                body.append(f"- {_case_line(named)}, {_owner(row)}"
                            + (f", {_age_words(left)} left" if left is not None else ""))
            if close > len(near):
                body.append(f"The shift snapshot names the {_count(len(near))} nearest; the other "
                            f"{_count(close - len(near))} are counted above.")
        workload = [w for w in shift.obs.get("workload") or [] if isinstance(w, Mapping)]
        if workload:
            body.append("Open cases by analyst: " + _join([
                f"{_assignee_word(w.get('analyst'))} {_count(w.get('open'))}" for w in workload[:6]]) + ".")
    # The attention queue ranks by status, verdict, risk and age: a different list from
    # the overdue cases, so an SLA answer shows the most overdue case itself instead.
    return Final(body=body, blocks=_keep(
        _block(view.ok("get_case"), "entity", view="entity", title="The most overdue case"),
        _block(shift, "categories", view="hbar", title="Open cases by analyst"),
    ))


def _since_phrase(ask: Ask, start: str | None) -> str:
    """"since 12:23 today", "since yesterday 18:40", "since 12 Oct": the suggestion's
    own words, placed in the day when the clock anchor dated them."""
    label = display_text(ask.slot("since"), 40)
    if start and _SINCE_CLOCK_RE.match(label or "") and " " not in label:
        return f"since {label} today"
    return f"since {label}" if label else "in the selected window"


def _final_new_since(view: PromptView, ask: Ask) -> Final | None:
    cases = view.ok("search_cases")
    stats = view.ok("case_stats", where=lambda r: not _is_clock(r))
    if cases is None and stats is None:
        return None
    start = _since_start(ask.slot("since"), _clock_today(view))
    when = _since_phrase(ask, start) if start else "in the last 7 days"
    count = cases.obs.get("count") if cases else _dig(stats.obs, "totals", "count")
    body: list[str] = []
    if not _num(count):
        body.append(f"No case opened {when}.")
    else:
        lead = f"**{_plural(count, 'case')}** opened {when}"
        open_now = _num(cases.obs.get("open")) if cases else None
        if open_now is not None:
            lead += f"; {_count(open_now)} of them {'is' if open_now == 1 else 'are'} still open"
        body.append(lead + ".")
    if not start:
        body.append(f"The suggestion's time ({display_text(ask.slot('since'), 40)}) could not be dated, so this "
                    "covers the last 7 days.")
    moved = _counts_moved(ask.slot("n"), count, "case") if ask.slot("n") is not None else ""
    if moved:
        body.append(moved)
    if stats and _num(count):
        parts = [f"{_count(_dig(g, 'metrics', 'count'))} {display_text(_dig(g, 'key', 'severity'), 20).lower()}"
                 for g in _stats_groups(stats.obs)]
        if parts:
            body.append("By severity: " + _join(parts) + ".")
    rows = [c for c in (cases.obs.get("cases") if cases else None) or [] if isinstance(c, Mapping)]
    still_open = [c for c in rows if str(c.get("status") or "") not in _TERMINAL_STATUSES]
    if still_open:
        body.append("Needs attention first, highest risk among those still open:")
        body.extend(f"- {_case_line(c)}" for c in still_open[:3])
    elif rows:
        # Cases that share the highest risk are all listed, never one of them alone (PB5).
        tied = _risk_ties(rows, rows[0])
        body.append("All of them are closed already; the highest risk was:" if not tied
                    else f"All of them are closed already; {_count(len(tied) + 1)} shared the highest risk:")
        body.extend(f"- {_case_line(c)}" for c in [rows[0], *tied][:3])
    return Final(body=body, blocks=_keep(
        _block(cases, "case_list", view="case_list", title="New cases by risk"),
        _block(stats, "categories", view="hbar", title="New cases by severity"),
    ))


def _final_volume(view: PromptView, ask: Ask) -> Final | None:
    by_rule = view.ok("case_stats", where=lambda r: r.input.get("group_by") == ["rule"])
    daily = view.ok("case_stats", where=lambda r: r.input.get("bucket") == "day")
    overall = view.ok("case_stats", where=lambda r: r.input == _VOLUME_TOTAL)
    if by_rule is None and daily is None and overall is None:
        return None
    body: list[str] = []
    source = overall or by_rule
    total = _num(_dig(source.obs, "totals", "count")) if source else None
    if total is not None:
        lead = f"**{_plural(total, 'new case')}** in the last 24 hours"
        # The 24 hours before from the UNGROUPED comparison: a sum of per-rule rows
        # would count a case with several rules more than once and drop the rules
        # outside the top five.
        rows = (_dig(overall.obs, "comparison", "rows") or []) if overall else []
        before = _num(rows[0].get("values", [None])[0]) if rows and isinstance(rows[0], Mapping) and \
            isinstance(rows[0].get("values"), list) and rows[0].get("values") else None
        if before is not None:
            lead += f", against {_count(before)} in the 24 hours before"
        usual = _volume_usual(view)
        if usual is not None:
            lead += f". The usual daily level is {_count(usual)}, the median of the seven days before"
        body.append(lead + ".")
        moved = _counts_moved(ask.slot("n"), total, "new case")
        if moved:
            body.append(moved)
        said_usual = _num(ask.slot("m"))
        if usual is not None and said_usual is not None and said_usual != usual:
            body.append(f"The suggestion said a usual {_count(said_usual)}; it is {_count(usual)} now.")
        groups = _stats_groups(by_rule.obs) if by_rule else []
        if groups and total:
            top = groups[0]
            rule = _dig(top, "key", "rule")
            share = (_num(_dig(top, "metrics", "count")) or 0) / total
            fell = _volume_falls(by_rule) if ask.starter == "volume_drop" else []
            if ask.starter == "volume_spike" and share > 0.5:
                # "Most" only for a real majority: at exactly half another rule can hold the
                # other half, a tie the "By rule" line below shows instead (PB5).
                body.append(f"Why: one rule drove most of it. {_code(rule)} created "
                            f"{_count(_dig(top, 'metrics', 'count'))} of them.")
            elif fell:
                body.append("Why: these rules created fewer cases than in the 24 hours before: "
                            + _join([f"{_code(name)} {_count(was)} to {_count(now)}" for name, was, now in fell[:3]])
                            + ".")
            else:
                body.append("By rule: " + _join([f"{_code(_dig(g, 'key', 'rule'))} {_count(_dig(g, 'metrics', 'count'))}"
                                                 for g in groups[:4]]) + ".")
    elif daily is not None:
        body.append(f"**{_plural(_dig(daily.obs, 'totals', 'count'), 'case')}** in the last 7 days.")
    if ask.starter == "volume_drop" and total is not None and not any(b.startswith("Why:") for b in body):
        body.append("Why: no single rule fell sharply against the 24 hours before; check that every source is "
                    "still sending events, since quiet sources create fewer cases.")
    return Final(body=body, blocks=_keep(
        _block(by_rule, "categories", view="hbar", title="New cases by rule, last 24 hours"),
        _block(daily, "series", view="bar", title="New cases per day, last 7 days"),
    ))


def _volume_falls(by_rule: Result | None) -> list[tuple[str, float, float]]:
    """``(rule, before, now)`` of the rules (among the top five) that created fewer
    cases than in the 24 hours before, biggest fall first."""
    rows = [r for r in (_dig(by_rule.obs, "comparison", "rows") or [] if by_rule else []) if isinstance(r, Mapping)]
    out: list[tuple[str, float, float]] = []
    for row in rows:
        values = row.get("values") if isinstance(row.get("values"), list) else []
        if len(values) == 2 and _num(values[0]) is not None and _num(values[1]) is not None \
                and (_num(values[0]) or 0) > (_num(values[1]) or 0):
            out.append((display_text(row.get("label"), 80), _num(values[0]) or 0, _num(values[1]) or 0))
    return sorted(out, key=lambda r: -(r[1] - r[2]))


def _final_noisy_rule(view: PromptView, ask: Ask) -> Final | None:
    verdicts = view.ok("case_stats", where=lambda r: r.input.get("group_by") == ["verdict"])
    everything = view.ok("case_stats", where=lambda r: not r.input.get("group_by") and not r.input.get("rule"))
    cases = view.ok("search_cases")
    named = ask.slot("rule") is not None
    pick = None if named else _noisy_rule_pick(view, ask)
    if not named and pick is None:
        if view.ok("case_stats", where=lambda r: r.input == _NOISY_BY_RULE) is None:
            return None
        # The card counted a rule without naming it, and no rule created a case since.
        return Final(body=["No detection rule created a case in the last 24 hours."])
    if verdicts is None and cases is None:
        return None
    rule = _code(ask.slot("rule") if pick is None else pick.rule)
    n = _num(_dig(verdicts.obs, "totals", "count")) if verdicts else _num(cases.obs.get("count"))
    m = _num(_dig(everything.obs, "totals", "count")) if everything else None
    body: list[str] = []
    if not n:
        body.append(f"Detection rule {rule} created no case in the last 24 hours.")
    elif pick is not None and pick.tied:
        # Several rules created that many cases: all of them are named, and the answer
        # says which one it goes on with (tie wording, polish round PB5).
        rules = [rule] + [_code(r) for r in pick.tied[:3]] + (
            [_plural(len(pick.tied) - 3, "other rule")] if len(pick.tied) > 3 else [])
        share = f" ({_pct(n * 100 / m)} each)" if m else ""
        of = f" of the {_count(m)}" if m else ""
        tie = "tied at that count" if pick.by_count else "tied for the most"
        body.append(f"Detection rules {_join(rules)} each created **{_plural(n, 'case')}**{of} in the last 24 "
                    f"hours{share}, {tie}; the rest of this answer is about {rule}, listed first.")
    else:
        lead = f"Detection rule {rule} created **{_plural(n, 'case')}**"
        if m:
            lead += f" of the {_count(m)} in the last 24 hours ({_pct(n * 100 / m)})"
        else:
            lead += " in the last 24 hours"
        body.append(lead + ".")
    if pick is not None and not pick.by_count and _num(ask.slot("n")) is not None:
        # No rule has the count the card showed now, so this may be a different rule:
        # never presented as the same rule's count having moved (as PB4's campaigns).
        # With rules tied for the most, the one the answer goes on with is one of them,
        # never "the rule with the most" (the opening sentence named them all).
        most = (f"{rule}, listed first, is one of the rules tied for the most" if pick.tied
                else f"{rule} is the rule with the most")
        body.append(f"No rule has exactly {_plural(ask.slot('n'), 'case')} in the last 24 hours now, the count the "
                    f"suggestion showed; {most}.")
    else:
        moved = _counts_moved(ask.slot("n"), n, "case")
        if moved:
            body.append(moved)
    groups = {str(_dig(g, "key", "verdict") or ""): _num(_dig(g, "metrics", "count")) or 0
              for g in (_stats_groups(verdicts.obs) if verdicts else [])}
    false = next((v for k, v in groups.items() if "false" in k.lower()), 0)
    if n and groups:
        if false / n >= 0.5:
            body.append(f"Why so many: {_count(false)} of them were false positives, so the rule fires on benign "
                        "activity; its threshold or suppression is the place to look.")
        else:
            body.append("By verdict: " + _join([f"{_count(v)} {display_text(k, 30).lower()}" for k, v in groups.items()])
                        + ". Most are not false positives, so the volume may be real activity worth hunting.")
    return Final(body=body, blocks=_keep(
        _block(verdicts, "categories", view="donut", title="The rule's cases by verdict"),
        _block(cases, "case_list", view="case_list", title="The rule's cases by risk"),
    ))


def _final_campaign(view: PromptView, ask: Ask) -> Final | None:
    case_ref = str(ask.slot("case") or "")
    campaign_id = ask.slot("campaign")
    lookup = _held_campaign(view, case_ref) if case_ref else view.ok("list_campaigns")
    if lookup is None:
        return None
    # The card names the campaign by one of its cases (polish round PB4): the answer is
    # about the campaign that holds that case now, named the same way, never by its
    # internal id (the Campaign table shows it), and it says plainly when none does.
    # The legacy wordings: by id, or "the most recently active campaign" (PB3).
    newest = not campaign_id and not case_ref
    if case_ref:
        row = _first_row(lookup)
    else:
        row = _open_campaign(view) if newest else _campaign_row(view, campaign_id)
    body: list[str] = []
    if row is None and case_ref:
        found = (lookup.obs.get("case_filter") or {}).get("found") is not False
        body.append(f"No campaign holds {_code(case_ref)} now: campaigns are rebuilt from shared entities every "
                    "day, and this one may have been resolved since the suggestion was made." if found else
                    f"Case {_code(case_ref)} was not found: it may have been deleted since the suggestion was made.")
        current = view.ok("list_campaigns", where=lambda r: r.input.get("status") == "open")
        if current is not None and current.obs.get("campaigns"):
            body.append("Open now: " + _say_campaigns(current))
        return Final(body=body, blocks=_keep(_block(current, "table", view="table", title="Open campaigns")))
    if row is None and newest:
        body.append("No campaign is open right now: campaigns are rebuilt from shared entities every day, and "
                    "this one may have been resolved or merged since the suggestion was made.")
        return Final(body=body)
    if row is None:
        body.append(f"Campaign {_code(campaign_id)} is no longer listed: campaigns are rebuilt from shared entities "
                    "every day, and one that gains cases gets a new id.")
        current = view.ok("list_campaigns", where=lambda r: r.input.get("status") == "open")
        if current is not None:
            body.append("Open now: " + _say_campaigns(current))
        first = _open_campaign(view)
        entity = _campaign_entity(first) if first is not None else None
        shared = view.ok("search_cases")
        if shared is not None and entity:
            body.append(_say_entity_cases(shared, _entity_phrase(entity)))
        return Final(body=body, blocks=_keep(
            _block(current, "table", view="table", title="Open campaigns"),
            _block(shared, "case_list", view="case_list", title="Cases on the shared entity"),
        ))
    entities = [e for e in row.get("entities") or [] if isinstance(e, str)][:3]
    # The shared entities and the techniques are two clauses (Round 13 close BF): one
    # list held both, so "IP …, 5 more and ATT&CK T1021 … and 3 more" left two
    # dangling tails and no noun on either.
    links = _join(_campaign_entities(row, 3))
    techniques = _campaign_techniques(row)
    if case_ref:
        subject = f"The campaign that includes {_code(case_ref)}"
    else:
        subject = "The most recently active open campaign" if newest else f"Campaign {_code(campaign_id)}"
    lead = (f"{subject} links **{_plural(row.get('case_count'), 'case')}**"
            + (f" through {links}" if links else "") + ".")
    if techniques:
        lead += f" It maps to {techniques}."
    body.append(lead)
    moved = _counts_moved(ask.slot("n"), row.get("case_count"), "case")
    if moved and newest:
        # The legacy "most recently active" wording names a position, not a campaign:
        # a newer campaign may hold it now, so a different count is never said to be
        # this campaign's growth.
        said = _num(ask.slot("n"))
        moved = (f"The suggestion counted {_plural(said, 'case')} in the campaign that was most recently "
                 "active then; a newer campaign may have taken its place since." if said is not None else "")
    if moved:
        body.append(moved)
    members = [c for c in row.get("case_ids") or [] if isinstance(c, str)]
    shared = view.ok("search_cases")
    # A8: its cases by what they are about (from the shared-entity search), never as a
    # list of bare internal ids; the Campaign table lists every member.
    named = [c for c in (shared.obs.get("cases") if shared else None) or [] if isinstance(c, Mapping)
             and c.get("case_id") in members]
    if named:
        body.append("Its cases, highest risk first:")
        body.extend(f"- {_case_line(c)}" for c in named[:5])
    if shared is not None and entities:
        phrase = _entity_phrase(entities[0])
        listed = [c for c in shared.obs.get("cases") or [] if isinstance(c, Mapping)]
        count = int(_num(shared.obs.get("count")) or 0)
        if listed and len(listed) == count and not _case_lower_bound(shared.obs):
            # Every case on the entity is listed: what the search adds to the campaign
            # is the cases on it OUTSIDE the campaign (its members are counted above).
            outside = count - sum(1 for c in listed if c.get("case_id") in members)
            body.append(f"No case outside the campaign involves {phrase}." if outside <= 0 else
                        f"**{_plural(outside, 'case')}** outside the campaign "
                        f"{'involves' if outside == 1 else 'involve'} {phrase}.")
        else:
            body.append(_say_entity_cases(shared, phrase))
    return Final(body=body, blocks=_keep(
        _block(lookup, "table", view="table", title="Campaign"),
        _block(shared, "case_list", view="case_list", title="Cases on the shared entity"),
    ))


def _final_source(view: PromptView, ask: Ask) -> Final | None:
    health = view.ok("source_health")
    if health is None:
        return None
    rows = [s for s in health.obs.get("sources") or [] if isinstance(s, Mapping)]
    coverage = health.obs.get("coverage") if isinstance(health.obs.get("coverage"), Mapping) else {}
    body: list[str] = []
    overall = (f"Ingestion overall: {_count(coverage.get('sources_enabled'))} of "
               f"{_plural(coverage.get('sources_total'), 'source')} enabled, "
               f"{_count(coverage.get('sources_silent'))} silent.")
    if ask.starter == "silent_source":
        wanted = str(ask.slot("source") or "")
        row = next((s for s in rows if wanted in (s.get("source_id"), s.get("name"))), None)
        if row is None:
            body.append(f"Log source {_code(wanted)} is not among the configured sources any more.")
        else:
            name = _code(row.get("name") or row.get("source_id"))
            if row.get("last_poll_failed"):
                body.append(f"Log source {name} is quiet because its last poll failed: check its connection and "
                            "credentials on the Sources page.")
            elif row.get("silent"):
                age = _num(row.get("last_event_age_seconds"))
                body.append(f"Log source {name} is silent" + (f": no events for {format_age(age)}" if age else "")
                            + ". Check that the sender still forwards to it.")
            elif not row.get("enabled"):
                body.append(f"Log source {name} is switched off, so it receives nothing.")
            else:
                body.append(f"Log source {name} is not quiet any more: it is receiving events again, so ingestion "
                            "is working.")
        body.append(overall)
    else:
        silent = [s for s in rows if s.get("silent") or s.get("last_poll_failed")]
        if silent:
            body.append(f"**{_plural(len(silent), 'log source')}** {'is' if len(silent) == 1 else 'are'} quiet now: "
                        + _join([_code(s.get("name") or s.get("source_id")) for s in silent[:5]]) + ".")
        else:
            body.append("No log source is quiet now: every enabled source is receiving events, so ingestion is "
                        "working.")
        moved = _counts_moved(ask.slot("n"), len(silent), "quiet source")
        if moved:
            body.append(moved)
        body.append(overall)
    return Final(body=body, blocks=_keep(_block(health, "table", view="table", title="Sources")))


def _final_budget(view: PromptView, ask: Ask) -> Final | None:
    cost = view.ok("cost_usage")
    if cost is None:
        return None
    o = cost.obs
    simulated = " (simulated)" if o.get("simulated") else ""
    surfaces = [x for x in o.get("by_surface") or [] if isinstance(x, Mapping)]
    said = _num(ask.slot("pct"))
    body: list[str] = []
    if ask.starter == "budget_chat":
        # Chat spend is the chat surface's own; the chat spending limit is not part of
        # the usage data chat can read, so its percentage is not restated as checked.
        chat = next((x for x in surfaces if str(x.get("key") or "") == "chat"), None)
        body.append(f"**Chat answers have used {_usd(chat.get('cost') if chat else 0)} today{simulated}.**")
        body.append("Chat answers are never blocked by the daily AI budget; only the optional chat spending limit "
                    "stops chat for the day.")
        if said is not None:
            body.append(f"The suggestion said {_count(said)}% of the chat spending limit was spent; the limit itself "
                        "is not in the usage data chat can read, so check it under Settings › Chat assistant.")
    else:
        # The daily AI budget excludes chat (Round 12 D5): its own spent, cap and share.
        daily = _dig(o, "budget", "daily")
        if _dig(o, "budget", "enabled") and isinstance(daily, Mapping) and _num(daily.get("cap")):
            pct = round_half_up((_num(daily.get("fraction")) or 0) * 100)  # as the card rounds it (T1)
            body.append(f"**{_usd(daily.get('spent'))} of today's {_usd(daily.get('cap'))} AI budget is spent "
                        f"({_count(pct)}%){simulated}.** Chat is not counted against it.")
            if said is not None and said != pct:
                body.append(f"The suggestion said {_count(said)}% spent; it is {_count(pct)}% now.")
        else:
            body.append(f"The daily AI budget is off, so nothing is counted against it; "
                        f"{_usd(o.get('today_cost_usd', o.get('total_cost_usd')))} was spent today{simulated}.")
        counted = [x for x in surfaces if str(x.get("key") or "") != "chat" and _num(x.get("cost"))]
        if counted:
            body.append("Spend today outside chat, by surface: "
                        + _join([f"{_code(x.get('key'))} {_usd(x.get('cost'))}" for x in counted[:3]]) + ".")
    return Final(body=body, blocks=_keep(
        _block(cost, "categories", view="hbar", title="Spend by surface"),
        _block(cost, "series", view="bar", title="Spend per hour today"),
    ))


#: What approving a waiting change does, by proposal kind (engine words).
_APPROVAL_KINDS = {
    "automation_ack": "an automation rule asks an analyst to acknowledge a case before it acts",
    "threshold_tuning": "a detection threshold change suggested by the tuning observer",
    "tuning": "a detection threshold change suggested by the tuning observer",
    "suppression": "a suppression for a rule that keeps firing on benign activity",
}


def _final_approvals(view: PromptView, ask: Ask) -> Final | None:
    status = view.ok("automation_status", "approvals")
    if status is None:
        return None
    o = status.obs
    items = [i for i in o.get("items") or [] if isinstance(i, Mapping)]
    pending = _num(o.get("pending")) or len(items)
    body: list[str] = []
    if not pending:
        body.append("No change is waiting for approval right now.")
    else:
        body.append(f"**{_plural(pending, 'change')}** {'is' if pending == 1 else 'are'} waiting for approval. "
                    "Nothing changes until someone approves on the Approvals page.")
    moved = _counts_moved(ask.slot("n"), pending, "change") if ask.slot("n") is not None else ""
    if moved:
        body.append(moved)
    expiring = sorted((str(i.get("expires_at")), n) for n, i in enumerate(items[:5], start=1)
                      if _date_text(i.get("expires_at")))
    if expiring and re.search(r"\bexpir", ask.lowered):
        body.append(f"The first to expire is change {expiring[0][1]}, on {_date_text(expiring[0][0])}.")
    for n, item in enumerate(items[:5], start=1):
        kind = str(item.get("kind") or "")
        what = _APPROVAL_KINDS.get(kind, f"a {display_text(kind, 40).replace('_', ' ')} change")
        cases = _num(item.get("cases"))
        dates = _join([f"requested {_date_text(item.get('created_at'))}" if _date_text(item.get("created_at")) else "",
                       f"expires {_date_text(item.get('expires_at'))}" if _date_text(item.get("expires_at")) else ""])
        body.append(f"- Change {n}" + (f" ({dates})" if dates else "") + f": {what}"
                    + (f", for {_plural(cases, 'case')}" if cases else "")
                    + ". Approving it records that decision; rejecting it leaves the case as it is.")
    return Final(body=body, blocks=_keep(_block(status, "table", view="table", title="Pending approvals")))


def _final_auto_close(view: PromptView, ask: Ask) -> Final | None:
    health = view.ok("soc_metrics", "auto_close_health")
    if health is None:
        return None
    o = health.obs
    state = str(o.get("status") or "")
    body: list[str] = []
    if state in ("degraded", "collapsed") or o.get("needs_attention"):
        body.append(f"Auto-close health is **{state.replace('_', ' ')}**: " + _say_auto_close(health))
    else:
        body.append(f"Auto-close health is not degraded now (status: {state.replace('_', ' ') or 'unknown'}). "
                    + _say_auto_close(health))
    previous = o.get("previous") if isinstance(o.get("previous"), Mapping) else {}
    if previous.get("available") and _num(previous.get("rate")) is not None:
        body.append(f"What changed: the rate was {_pct(previous.get('rate'), ratio=True)} in the window before.")
    elif previous.get("reason"):
        body.append(f"What changed cannot be measured yet: {_plain(previous.get('reason'), 200)}.")
    return Final(body=body, blocks=_keep(_block(health, "kpis", view="kpi_group", title="Auto-close health")))


def _final_triage(view: PromptView, ask: Ask) -> Final | None:
    shift = view.ok("shift_report")
    if shift is None:
        found = view.ok("search_cases")
        if found is None:
            return None
        total = _num(found.obs.get("count")) or 0
        if not total:
            return Final(body=["No open case needs attention right now."])
        rows = [c for c in found.obs.get("cases") or [] if isinstance(c, Mapping)]
        tied = _risk_ties(rows, rows[0]) if rows else []
        start = ("start with the highest risk:" if not tied else
                 f"start with the highest risk ({_count(len(tied) + 1)} share risk {_shown_risk(rows[0])}):")
        body = [f"**{_plural(total, 'open case')}**; {start}", *_case_bullets(found, limit=3)]
        return Final(body=body, blocks=_keep(_block(found, "case_list", view="case_list", title="Open cases by risk")))
    head = shift.obs.get("headline") if isinstance(shift.obs.get("headline"), Mapping) else {}
    attention = [a for a in shift.obs.get("attention") or [] if isinstance(a, Mapping)]
    body = [f"**{_plural(head.get('open'), 'open case')}**; start with these, ranked by status, verdict, risk "
            "and age:"]
    for row in attention[:3]:
        # The case line already says its status and verdict; the age is the one fact
        # the ranking adds.
        age = f", open {_age_words(row.get('age_minutes'))}" if _num(row.get("age_minutes")) else ""
        body.append(f"- {_case_line(row)}{age}")
    if not attention:
        body = ["No open case needs attention right now."]
    return Final(body=body, blocks=_keep(_block(shift, "case_list", view="case_list", title="Needs attention")))


def _final_technique_hunt(view: PromptView, ask: Ask) -> Final | None:
    technique = ask.techniques[0] if ask.techniques else ""
    mitre = view.ok("mitre_lookup")
    counted = view.ok("case_stats", where=lambda r: r.input.get("group_by") == ["mitre_technique"])
    logs, search = view.ok("log_stats"), view.ok("search_logs")
    cases = view.ok("search_cases")
    if mitre is None and counted is None:
        return None
    rows = [t for t in (mitre.obs.get("techniques") if mitre else None) or [] if isinstance(t, Mapping)]
    name = next((display_text(t.get("name"), 80) for t in rows if t.get("id") == technique), "")
    rules = _technique_rules(view, technique)
    subject = f"ATT&CK technique **{display_text(technique, 12)}{' ' + name if name else ''}**"
    body: list[str] = []
    if counted is not None:
        count = int(sum((_num(_dig(g, "metrics", "count")) or 0) for g in _stats_groups(counted.obs)
                        if _dig(g, "key", "mitre_technique") == technique))
        if count:
            lead = f"{subject} appears in **{_plural(count, 'case')}** created in the last 7 days"
            lead += f", from {_plural(len(rules), 'rule')}." if rules else "."
        else:
            lead = f"{subject} appears in no case created in the last 7 days."
        body.append(lead)
        moved = _counts_moved(ask.slot("n"), count, "case")
        if moved:
            body.append(moved)
    else:
        body.append(f"{subject}: the case counts could not be read, so only the technique is described.")
    top = _newest_case(cases) if cases is not None else None
    if cases is not None and rules and counted is not None and count:
        body.extend(_technique_cases_part(view, technique, count))
    entity = _entity_of({"case": top}) if top else None
    if entity is not None and (logs is not None or search is not None):
        phrase = _entity_phrase(f"{entity[0]}:{entity[1]}")
        said = _say_log_stats(logs) if logs is not None else _say_search_logs(search)
        body.append(f"Beyond those cases, the logs of the last 7 days for {phrase}, the entity of "
                    f"{_case_head(top, bold=False)}: " + said)
    return Final(body=body, blocks=_keep(
        _block(mitre, "mitre", view="mitre", title="ATT&CK technique"),
        _block(cases, "case_list", view="case_list", title="Cases from its top rule"),
        _block(logs, "categories", view="hbar", title="The entity's log activity"),
    ))


def _final_case_entity(view: PromptView, ask: Ask) -> Final | None:
    got = view.ok("get_case")
    if got is None:
        return _case_missing(view, ask)
    entity = _entity_of(got.obs)
    case = _dig(got.obs, "case") or {}
    this = "This case" if view.case_scoped else _case_head(case, start=True)
    if entity is None:
        return Final(body=[f"{this} names no main entity, so there is no activity to look up."])
    phrase = _entity_phrase(f"{entity[0]}:{entity[1]}")
    of = "this case" if view.case_scoped else _case_head(case)
    body = [f"The main entity of {of} is {phrase}."]
    stats, search = view.ok("log_stats"), view.ok("search_logs")
    if ask.slot("compare"):
        return _final_case_entity_compare(of, phrase, stats)
    if stats is not None:
        body.append("In the logs: " + _say_log_stats(stats))
    elif search is not None:
        body.append("In the logs: " + _say_search_logs(search))
    others = view.ok("search_cases")
    if others is not None:
        body.append(_say_entity_cases(others, "it", exclude=case.get("case_id")))
    return Final(body=body, blocks=_keep(
        _block(stats, "categories", view="hbar", title="The entity's log activity"),
        _block(stats, "series", view="line", title="Its events over time"),
        _block(others, "case_list", view="case_list", title="Cases on the entity"),
    ))


def _final_case_entity_compare(of: str, phrase: str, stats: Result | None) -> Final:
    """The case's main entity: its log activity against the period before."""
    if stats is None:
        return Final(body=[f"The main entity of {of} is {phrase}, but its log activity could not be counted, "
                           "so there is nothing to compare."])
    comp = _comparison_of(stats.obs)
    body = [f"The main entity of {of} is {phrase}. " + _say_log_stats(stats, subject="for it")]
    lines = _say_comparison(comp, limit=2, with_note=False, bullets=True) if comp else []
    if lines:
        body.append("Compared with the period before:")
        body.extend(lines)
    else:
        body.append("The period before could not be counted, so this answer has no comparison.")
    return Final(body=body, blocks=_keep(
        _block_titled(stats, "comparison", view="grouped_bar", title="The entity's activity versus the period before"),
        _block(stats, "categories", view="hbar", title="The entity's log activity"),
    ))


def _final_compare_cases(view: PromptView, ask: Ask) -> Final | None:
    """The earlier cases against the period before (``_final_compare`` names every
    filter in its headline); its chips about months and reports are not about them."""
    final = _final_compare(view, ask)
    if final is not None:
        final.follow_ups = []
    return final


def _final_case_related(view: PromptView, ask: Ask) -> Final | None:
    got = view.ok("get_case")
    if got is None:
        return _case_missing(view, ask)
    case = _dig(got.obs, "case") or {}
    case_id = case.get("case_id")
    entity = _entity_of(got.obs)
    others = view.ok("search_cases")
    body: list[str] = []
    rows = [c for c in (others.obs.get("cases") if others else None) or [] if isinstance(c, Mapping)
            and c.get("case_id") != case_id]
    this = "this case" if view.case_scoped else _case_head(case)
    if entity is None:
        body.append(f"{_upper_first(this)} names no main entity, so no other case can share it.")
    elif rows:
        body.append(f"**{_plural(len(rows), 'other case')}** {'shares' if len(rows) == 1 else 'share'} "
                    f"{_entity_phrase(f'{entity[0]}:{entity[1]}')} with {this}:")
        body.extend(f"- {_case_line(c)}" for c in rows[:5])
    else:
        body.append(f"No other case shares {_entity_phrase(f'{entity[0]}:{entity[1]}')} with {this}.")
    camps = view.ok("list_campaigns")
    linked = [c for c in (camps.obs.get("campaigns") if camps else None) or [] if isinstance(c, Mapping)
              and case_id in (c.get("case_ids") or [])]
    if linked:
        body.append("It is part of " + _say_campaigns(camps, linked))
    return Final(body=body, blocks=_keep(_block(others, "case_list", view="case_list", title="Cases on the entity")))


# --------------------------------------------------------------------------- #
# Round 13 (SPEC-chat §4.1, T4): anchored follow-ups. The engine keeps a model chip
# only when it names something the answer shows (``agents.chat_followups``), so the
# Demo planner words its chips around what each answer shows: its window, the cases it
# lists, its ATT&CK techniques, the dimension it groups by and the figures it shows.
# Every chip names only engine words and identifiers (window labels, case and
# technique ids, dimension words, figure labels, configured source names), never a
# log value. A chip that cannot be filled from the answer is skipped.
# --------------------------------------------------------------------------- #
_REF_ORDINAL_RE = re.compile(r"^t([1-9][0-9]{0,3})\.a[1-9][0-9]{0,2}$")
_DIMENSION_WORDS = {"ip": "source IP", "source.ip": "source IP", "src_ip": "source IP", "user": "user",
                    "host": "host", "rule": "rule", "rule_name": "rule", "severity": "severity",
                    "verdict": "verdict", "assignee": "assignee", "status": "status", "source": "source",
                    "action": "event action", "priority": "priority"}


@dataclass
class _ChipContext:
    window: str = ""
    cases: list[str] = field(default_factory=list)
    techniques: list[str] = field(default_factory=list)
    dimensions: list[str] = field(default_factory=list)
    sources: list[str] = field(default_factory=list)
    #: Figure labels the shown blocks carry (the engine anchors a chip on them).
    labels: list[str] = field(default_factory=list)

    def names(self, chip: str) -> bool:
        """Whether ``chip`` names something this answer shows (the engine's anchors,
        approximately: the final say is the engine's selector)."""
        low = chip.lower()
        words = [self.window.lower()] if self.window else []
        words += [c.lower() for c in self.cases] + [t.lower() for t in self.techniques]
        words += [d.lower() for d in self.dimensions] + [s.lower() for s in self.sources] + self.labels
        return any(w and re.search(rf"(?<!\w){re.escape(w)}(?:e?s)?(?!\w)", low) for w in words)


#: The figure labels each lookup's key-figure block carries, by ``(tool, kind)``.
_RESULT_LABELS: dict[tuple[str, str | None], tuple[str, ...]] = {
    ("soc_metrics", "posture"): ("active risk index", "cases", "open now", "false-positive rate", "automation rate"),
    ("soc_metrics", "noise_funnel"): ("escalated", "auto-cleared by ai", "closed by a human"),
    ("soc_metrics", "auto_close_health"): ("auto-close rate", "decided cases", "routed to a human"),
    ("soc_metrics", "timing"): ("mttd", "mttr"),
    ("shift_report", None): ("open cases", "escalated", "sla breached"),
    ("cost_usage", None): ("ai spend", "tokens", "model calls"),
    ("search_cases", None): ("matching cases", "average risk"),
    ("case_stats", None): ("cases",),
    ("automation_status", "approvals"): ("pending approvals", "cases"),
}


def _shown_refs(final: Final) -> list[str]:
    """The ``tN.aK`` refs the answer's blocks show, report sections included."""
    refs: list[str] = []

    def walk(blocks: Any) -> None:
        for block in blocks or []:
            if not isinstance(block, Mapping):
                continue
            ref = str(block.get("ref") or "")
            if _REF_ORDINAL_RE.match(ref):
                refs.append(ref)
            for section in block.get("sections") or []:
                if isinstance(section, Mapping):
                    walk(section.get("items"))

    walk(final.blocks)
    return refs


def _shown_results(view: PromptView, final: Final) -> list[Result]:
    """The lookups whose artifacts the answer shows (by ``tN.aK`` refs, report
    sections included); an answer that shows none is about every data lookup it ran
    (the engine anchors it the same way)."""
    ordinals = [int(m.group(1)) for m in (_REF_ORDINAL_RE.match(ref) for ref in _shown_refs(final)) if m]
    by_ordinal = {r.ordinal: r for r in view.results()}
    shown = [by_ordinal[o] for o in dict.fromkeys(ordinals) if o in by_ordinal]
    return shown or [r for r in view.results()
                     if r.ok and r.tool not in _REFERENCE_TOOLS and not _is_clock(r) and not _is_anchor_call(r)]


def _shown_case_handles(view: PromptView, final: Final) -> set[str]:
    """The cases the answer's blocks show: the rows of a shown case list and the case
    of a shown case card."""
    refs = set(_shown_refs(final))
    out: set[str] = set()
    for r in view.results():
        if not r.ok:
            continue
        if r.tool == "search_cases":
            entry = r.artifact("case_list")
            if entry is not None and entry.ref in refs:
                out.update(h for h in (_case_handle(c) for c in r.obs.get("cases") or []) if h)
        elif r.tool == "get_case":
            entry = r.artifact("entity")
            handle = _case_handle(_dig(r.obs, "case"))
            if entry is not None and entry.ref in refs and handle:
                out.add(handle)
    return out


def _names_handle(text: str, handle: str) -> bool:
    """Whether ``text`` names the case ``handle`` as a whole token."""
    return bool(handle) and re.search(rf"(?<![\w.:-]){re.escape(handle)}(?![\w:-]|\.\w)", text) is not None


def _case_handle(row: Any) -> str | None:
    if not isinstance(row, Mapping):
        return None
    for key in ("case_number", "case_id"):
        value = row.get(key)
        if isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}", value):
            return value
    return None


def _chip_context(view: PromptView, final: Final) -> _ChipContext:
    ctx = _ChipContext()
    for r in _shown_results(view, final):
        o = r.obs
        if not ctx.window and isinstance(o.get("window"), str) and o.get("window").strip():
            ctx.window = re.sub(r"\s*\([^()]*\)\s*$", "", display_text(o.get("window"), 60)).strip()
        rows: list[Any] = []
        if r.tool == "get_case":
            rows = [_dig(o, "case")]
            ctx.techniques += [m.get("id") for m in o.get("mitre") or [] if isinstance(m, Mapping)]
        elif r.tool == "search_cases":
            rows = list(o.get("cases") or [])
        elif r.tool == "shift_report":
            rows = list(o.get("attention") or [])
        elif r.tool == "list_campaigns":
            ctx.techniques += [m for camp in o.get("campaigns") or [] if isinstance(camp, Mapping)
                               for m in camp.get("mitre") or [] if isinstance(m, str)]
        elif r.tool == "mitre_lookup":
            ctx.techniques += [t.get("id") for t in o.get("techniques") or [] if isinstance(t, Mapping)]
        ctx.cases += [h for h in (_case_handle(row) for row in rows) if h]
        group = r.input.get("group_by")
        for key in group if isinstance(group, list) else [group] if isinstance(group, str) else []:
            word = _DIMENSION_WORDS.get(str(key))
            if word:
                ctx.dimensions.append(word)
        ctx.labels += list(_RESULT_LABELS.get((r.tool, r.kind), _RESULT_LABELS.get((r.tool, None), ())))
        if r.tool == "source_health":
            ctx.sources += [s.get("name") for s in o.get("sources") or []
                            if isinstance(s, Mapping) and isinstance(s.get("name"), str)
                            and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9 _.()/&-]{0,59}", s.get("name"))]
    # A chip names a case only when this answer shows it: a shown case list or case
    # card holds it, or the answer's own words name it. A case the lookup merely
    # observed (the shift snapshot's attention queue behind an "Open cases by analyst"
    # chart, when no case is near its target) is never offered (the engine drops such
    # a chip too, chat_followups).
    shown = _shown_case_handles(view, final)
    words = "\n".join([*final.body, *final.lead, *final.notes, final.closing])
    ctx.cases = [c for c in dict.fromkeys(ctx.cases) if c in shown or _names_handle(words, c)]
    if view.case_scoped:
        # A Case Manager chat is about ONE case: its chips name that case only, never
        # another case a lookup of this turn listed.
        scoped = next((r for r in view.results() if r.tool == "get_case" and r.ok
                       and not r.input.get("case_id")), None) or view.ok("get_case")
        handle = _case_handle(_dig(scoped.obs, "case")) if scoped is not None else None
        ctx.cases = [handle] if handle else []
    ctx.techniques = list(dict.fromkeys(t for t in ctx.techniques
                                        if isinstance(t, str) and _TECHNIQUE_ID_RE.fullmatch(t)))
    ctx.dimensions = list(dict.fromkeys(ctx.dimensions))
    ctx.sources = list(dict.fromkeys(ctx.sources))
    asked = _asked_sources(view)
    if asked:
        # A source answer's chips name the source it is about (the quiet one), never
        # simply the first configured source.
        ctx.sources = [s for s in ctx.sources if s in asked] + [s for s in ctx.sources if s not in asked]
    return ctx


def _asked_sources(view: PromptView) -> list[str]:
    """The source names a source starter is about: the named source (by id or name),
    else the quiet ones."""
    health = view.ok("source_health")
    rows = [s for s in (health.obs.get("sources") if health else None) or [] if isinstance(s, Mapping)]
    template, slots = view.starter or ("", {})
    if template == "silent_source":
        wanted = str(slots.get("source") or "")
        return [str(s.get("name")) for s in rows if wanted in (s.get("source_id"), s.get("name")) and s.get("name")]
    if template in ("silent_sources", "silent_source_unnamed"):
        return [str(s.get("name")) for s in rows if (s.get("silent") or s.get("last_poll_failed")) and s.get("name")]
    return []


_TECHNIQUE_ID_RE = re.compile(r"T\d{4}(?:\.\d{3})?")

#: Each intent's chips, best first: ``(text, tools its next turn needs)``. Placeholders
#: are filled from the answer (:class:`_ChipContext`); a chip whose placeholder has no
#: value is skipped. Wording names what the answer shows so the engine keeps the chip.
_CHIPS: dict[str, tuple[tuple[str, tuple[str, ...]], ...]] = {
    "posture": (("Which cases drove the false-positive rate {in_window}?", ("search_cases",)),
                ("Which open cases push the Active Risk Index up?", ("search_cases",)),
                ("How did the automation rate change {in_window}?", ("soc_metrics",))),
    "summary": (("Which cases drove the false-positive rate {in_window}?", ("search_cases",)),
                ("List the true positives {in_window}", ("search_cases",)),
                ("Show the noise reduction funnel {in_window}", ("soc_metrics",))),
    # Chat's case lookups cannot filter by who closed a case, so "auto-cleared by AI"
    # and "closed by a human" are asked as the exact breakdown by closer.
    "noise": (("Which cases were escalated {in_window}?", ("search_cases",)),
              ("Who closed the cases {in_window}?", ("case_stats",))),
    "metric": (("Show the case trend {in_window}", ("soc_metrics",)),),
    "shift": (("Investigate {case}", ("get_case",)),
              ("Which SLA breached cases are oldest?", ("shift_report",)),
              ("Which cases were escalated {in_window}?", ("search_cases",))),
    "cost": (("What drove the AI spend {in_window}?", ("cost_usage",)),
             ("Which model spent the most {in_window}?", ("cost_usage",)),
             ("Compare the AI spend {in_window} with the period before", ("cost_usage",))),
    "budget": (("Which model spent the most {in_window}?", ("cost_usage",)),
               ("Show the AI spend by role {in_window}", ("cost_usage",))),
    "top": (("Which cases involve the top {dimension} {in_window}?", ("search_cases",)),
            ("Which rules fired most {in_window}?", ("log_stats",))),
    "logs": (("Show these events by host {in_window}", ("log_stats",)),),
    "brute": (("Which cases involve the top source IP {in_window}?", ("search_cases",)),
              ("Show the failed sign-ins by user {in_window}", ("log_stats",))),
    "cases": (("Investigate {case}", ("get_case",)),
              ("Summarise {case} for a handoff note", ("get_case",)),
              ("Which of these cases are still open?", ("search_cases",))),
    "case": (("Which other cases share an entity with {case}?", ("search_cases",)),
             ("Summarise {case} for a handoff note", ("get_case",)),
             ("Explain {technique} and whether other cases show it", ("mitre_lookup",))),
    "hunt": (("Investigate {case}", ("get_case",)),
             ("Show every log event for this indicator {in_window}", ("search_logs",)),
             ("Summarise {case} for a handoff note", ("get_case",))),
    "mitre": (("Which cases show {technique}?", ("case_stats", "search_cases")),
              ("Hunt for more activity of {technique} in the logs", ("log_stats",))),
    "sources": (("Show recent events from {source}", ("search_logs",)),
                ("How many cases came from {source}?", ("source_health", "case_stats"))),
    "breakdown": (("List the cases behind the top {dimension} {in_window}", ("search_cases",)),
                  ("Which {dimension} changed most {in_window}?", ("case_stats",)),
                  ("Show the {dimension} breakdown as a trend {in_window}", ("case_stats",))),
    "trend": (("Which rules created the most cases {in_window}?", ("case_stats",)),
              ("List the true positives {in_window}", ("search_cases",))),
    "compare": (("Which rules drove the false positives {in_window}?", ("case_stats",)),
                ("List the false positives {in_window}", ("search_cases",))),
    "perf_report": (("Which cases drove the false-positive rate {in_window}?", ("search_cases",)),
                    ("Show the noise reduction funnel {in_window}", ("soc_metrics",)),
                    ("Which rules created the most cases {in_window}?", ("case_stats",))),
    # The deep dive already lists the cases on its entity.
    "deep": (("Investigate {case}", ("get_case",)),),
    "rate": (("Which cases drove the false-positive rate {in_window}?", ("search_cases",)),
             ("List the true positives {in_window}", ("search_cases",))),
    # The audit trail filters by action type, never by "analysts" or a ranking.
    "audit": (("Show the case status changes {in_window}", ("audit_search",)),),
    "my_cases": (("Investigate {case}", ("get_case",)),
                 ("Which assignee has the most open cases?", ("case_stats",)),
                 ("Summarise {case} for a handoff note", ("get_case",))),
    "sla": (("Investigate {case}", ("get_case",)),
            ("Summarise {case} for a handoff note", ("get_case",))),
    "sla_case": (("Summarise {case} for a handoff note", ("get_case",)),
                 ("Which other cases share an entity with {case}?", ("search_cases",))),
    "new_since": (("Investigate {case}", ("get_case",)),
                  ("Which of the cases {in_window} are critical?", ("search_cases",)),
                  ("Show the cases {in_window} by rule", ("case_stats",))),
    "volume": (("List the cases from the top rule {in_window}", ("search_cases",)),
               ("Show the cases {in_window} by severity", ("case_stats",))),
    "noisy_rule": (("Investigate {case}", ("get_case",)),
                   ("List the false positives from this rule {in_window}", ("search_cases",))),
    "campaign": (("Investigate {case}", ("get_case",)),
                 ("Which other cases show {technique}?", ("case_stats", "search_cases")),
                 ("Summarise {case} for a handoff note", ("get_case",))),
    "approvals": (("Which pending approval expires first?", ("automation_status",)),
                  ("Which open cases need human review?", ("search_cases",))),
    "source": (("Show recent events from {source}", ("search_logs",)),
               ("How many cases came from {source}?", ("source_health", "case_stats"))),
    # "Routed to a human" counts decisions by decision time, which no case filter can
    # list; who closed the window's cases is the exact breakdown beside it.
    "auto_close": (("Who closed the cases {in_window}?", ("case_stats",)),),
    "triage": (("Investigate {case}", ("get_case",)),
               ("Summarise {case} for a handoff note", ("get_case",))),
    "technique_hunt": (("Which cases show {technique}?", ("case_stats", "search_cases")),
                       ("Investigate {case}", ("get_case",))),
    "case_entity": (("Summarise {case} for a handoff note", ("get_case",)),
                    ("Which other cases share an entity with {case}?", ("search_cases",))),
    "case_related": (("Summarise {case} for a handoff note", ("get_case",)),
                     ("Investigate {case}", ("get_case",))),
}
#: Intents that answer like another for their chips.
_CHIP_ALIASES = {"tp": "cases", "pivot": "hunt", "brief": "case", "log_count": "top", "regroup": "top",
                 "entity_cases": "breakdown"}


def _fill_chip(text: str, ctx: _ChipContext, view: PromptView) -> str | None:
    values = {
        "in_window": _in(ctx.window) if ctx.window else None,
        "window": ctx.window or None,
        "case": ctx.cases[0] if ctx.cases else None,
        "technique": ctx.techniques[0] if ctx.techniques else None,
        "dimension": ctx.dimensions[0] if ctx.dimensions else None,
        "source": ctx.sources[0] if ctx.sources else None,
    }
    needed = re.findall(r"\{([a-z_]+)\}", text)
    if any(values.get(name) is None for name in needed):
        return None
    if "{dimension}" in text and "involve the top" in text and values["dimension"] not in ("user", "host", "source IP"):
        return None  # only an entity has cases on it
    if re.search(r"changed most|compare|with the period before", text, re.IGNORECASE) and (
            not ctx.window or ctx.window.lower().startswith("all time")):
        return None  # nothing comes before "all time"
    chip = text.format(**{name: values[name] for name in needed})
    return chip[:1].upper() + chip[1:]


def _anchored_follow_ups(view: PromptView, ask: Ask, final: Final) -> list[str]:
    """Up to three chips: the final's own chips about this answer first (a zero
    result's widening chips, "Break that down by user instead", "Explain case X"),
    then chips about what this answer shows, then the intent's static chips (which the
    engine keeps only for an answer with no data, as product help)."""
    intent = ask.intent if ask.intent in _CHIPS else _CHIP_ALIASES.get(ask.intent, "")
    own = [c for c in final.follow_ups if c not in _STATIC_CHIPS]
    if any(_WIDENING_CHIP_RE.match(c) for c in own):
        return own[:3]  # a zero result: widening it is the next step
    if final.answer_kind not in ("data", "mixed"):
        return list(dict.fromkeys(final.follow_ups))[:3]
    ctx = _chip_context(view, final)
    # The final's own chips that name what the answer shows lead; the rest follow
    # the chips about this answer (the engine drops a chip that names nothing shown).
    chips: list[str] = [c for c in own if ctx.names(c)]
    later = [c for c in own if c not in chips]
    if intent:
        asked = {ask.question.strip().lower(), *(q.strip().lower() for q in view.prior_questions)}
        for text, tools in _CHIPS[intent]:
            if view.case_scoped and text.startswith("Investigate {case}"):
                continue  # the chat is already about this case
            if text.startswith("Which of these cases are still open") and not _lists_open_and_closed(view):
                continue  # SPEC §4.1: only under a list that holds open and closed cases
            chip = _fill_chip(text, ctx, view)
            if chip and chip.lower() not in asked and all(view.can(t) for t in tools) and chip not in chips:
                chips.append(chip)
    # The intent table's fixed chips ("Hunt the source IP behind the newest SQL
    # injection case") are about no particular answer: a data answer never offers them
    # (the engine adds its own value-free chips about what the answer shows).
    for chip in later:
        if chip not in chips:
            chips.append(chip)
    return chips[:3]


def _lists_open_and_closed(view: PromptView) -> bool:
    """Whether this turn's last case search counted open AND closed cases (its exact
    ``open`` figure strictly between none and every match)."""
    found = next((r for r in reversed(view.results()) if r.tool == "search_cases" and r.ok), None)
    if found is None:
        return False
    open_now, count = _num(found.obs.get("open")), _num(found.obs.get("count"))
    return open_now is not None and count is not None and 0 < open_now < count


#: A zero result's widening chips ("Show the same for all time", "Show the same
#: without the severity filter", "Same for the last 7 days").
_WIDENING_CHIP_RE = re.compile(r"^(?:Show the same (?:for|without|across) |Same for )")
#: The intent table's fixed chips ("How is our security posture right now?"): about no
#: particular answer, so they come after the chips about this one.
_STATIC_CHIPS = frozenset(text for key, (text, _tools) in _FOLLOW_UPS.items()
                          if key not in ("by_user", "by_host", "as_table", "week"))


# --------------------------------------------------------------------------- #
# Round 13 (SPEC-chat T6): the conversation title in the final header, written only
# on a conversation's first answer, 2 to 6 words in sentence case naming what the
# conversation is about. Engine words only: never a log value or case text.
# --------------------------------------------------------------------------- #
_STARTER_TITLES: dict[str, str] = {
    "needs_human": "Case that needs a person", "my_cases": "My open cases", "my_cases_one": "Next step on my case",
    "sla_breached": "Cases past their response target", "sla_breached_one": "Case past its response target",
    "sla_close": "Cases near their response target", "sla_close_one": "Case near its response target",
    "new_cases": "New cases to triage", "new_cases_one": "New cases to triage",
    "volume_spike": "Rise in new cases", "volume_drop": "Drop in new cases", "noisy_rule": "Noisy detection rule",
    "noisy_rule_unnamed": "Noisy detection rule", "campaign": "Campaign links", "silent_source": "Quiet log source",
    "silent_source_unnamed": "Quiet log source", "silent_sources": "Quiet log sources",
    "budget_ai": "Today's AI spend", "budget_chat": "Today's chat spend", "shift_start": "Shift brief",
    "shift_handoff": "Shift handoff", "weekly": "Last week compared", "hunt": "ATT&CK technique hunt",
    "approvals": "Changes waiting for approval", "approvals_one": "Change waiting for approval",
    "platform": "Auto-close health", "demo": "What Demo Mode simulates", "triage": "Open cases to triage",
    "posture": "Security posture now", "explain_metric": "Active Risk Index explained",
    "learn_app": "Getting started", "connect_source": "Connecting a log source",
}
_INTENT_TITLES: dict[str, str] = {
    "posture": "Security posture", "noise": "Noise reduction", "shift": "Shift brief", "cost": "AI spend",
    "brute": "Failed sign-ins", "tp": "True positives", "case": "Case investigation", "logs": "Log search",
    "log_count": "Log event counts", "hunt": "Indicator hunt", "pivot": "Hunt from a case",
    "mitre": "ATT&CK techniques", "sources": "Log source health", "campaigns": "Campaign list", "cases": "Case list",
    "help": "Console help", "explain_metric": "A metric explained", "change": "A settings change",
    "unsupported": "A question chat cannot answer", "respond": "Response actions",
    "out_of_scope": "Outside what chat does", "remember": "A note to remember", "breakdown": "Case breakdown",
    "trend": "Trend over time", "compare": "Period comparison", "brief": "Investigation brief",
    "deep": "Entity deep dive", "clarify": "Choosing a trend", "summary": "Period summary",
    "rate": "True-positive rate", "entity_cases": "Cases by entity", "audit": "Audit trail",
    "automation": "Automation status", "knowledge": "Runbooks and guidance", "fallback": "Getting started",
    "top": "Top log activity", "metric": "SOC metrics",
    # Round 13 (T6): every intent a first question can reach has a title, the starter
    # intents typed in words too ("Which cases are past their SLA?").
    "technique_cases": "ATT&CK technique cases", "source_cases": "Cases from a log source",
    "case_related": "Related cases", "verdict_cases": "Cases by verdict", "approvals": "Changes waiting for approval",
    "auto_close": "Auto-close health", "budget": "AI spend today", "campaign": "Campaign links",
    "my_cases": "My open cases", "new_since": "New cases", "noisy_rule": "Noisy detection rule",
    "sla": "Response targets", "sla_case": "Case response target", "triage": "Open cases to triage",
    "source": "Log source health", "volume": "Case volume", "technique_hunt": "ATT&CK technique hunt",
    "case_entity": "Case entity activity", "perf_report": "SOC performance report",
    # Follow-up intents (a chip under an earlier answer), titled for completeness.
    "these_open": "Open cases", "top_entity": "Top entity", "entity_more": "Entity activity",
    "top_group_cases": "Cases in the top group", "compare_cases": "Case comparison",
    "source_events": "Log source events", "regroup": "Log breakdown", "regroup_cases": "Case breakdown",
}
#: The intents only an earlier answer leads to (a re-run, a view change, a step of an
#: earlier answer) or no question at all: they never title a conversation.
_UNTITLED_INTENTS = frozenset({"rerun", "rerun_step", "reshape", "explain_step", "empty"})
_METRIC_TITLES = {"timing": "Response times", "auto_close_health": "Auto-close health",
                  "mitre_coverage": "ATT&CK coverage", "case_mix": "Case mix", "trends": "Case trends",
                  "posture": "Security posture", "noise_funnel": "Noise reduction",
                  "agent_improvement": "Agent improvement", "feedback": "Analyst feedback"}
_TREND_TITLES = {"timing": "Response time trend", "rates": "False-positive rate trend", "cases": "Case trend",
                 "alerts": "Alert trend", "cost": "AI spend trend", "automation": "Automation rate trend"}


def _conversation_title(view: PromptView, ask: Ask, final: Final) -> str:
    """The first answer's title (``""`` after earlier messages, in a case chat, or
    when nothing fits the title rules): what the conversation is about, plus ONE
    detail that tells it apart from others like it where one exists (Round 13
    polish): the case number (first, so a narrow history rail still shows it), a
    validated ATT&CK technique id, the window, the dimension, the console page a
    product-help answer points to, or a rule id that passes the rule grammar, as
    written. Never an indicator, entity value, log text or case title."""
    if view.case_scoped or view.prior_questions or view.prior_answers:
        return ""
    # A console starter keeps its curated title, the classified ones too ("What Demo
    # Mode simulates", not "Console help"); a starter about one case, technique or
    # rule names it.
    starter = ask.starter or (view.starter[0] if view.starter else None)
    if starter:
        title = _starter_title(view, ask, starter)
        if title:
            return title
    title = _specific_title(view, ask)
    if not title and ask.intent not in ("case", "brief"):
        # (A case or brief is named by its rule and number below, not its report.)
        envelope = next((b for b in final.blocks if b.get("type") == "report"), None)
        if envelope is not None:
            # A report names itself ("Shift handoff", "Cases report, last 7 days");
            # its own title, without any case id after a colon.
            title = _first_fit(display_text(envelope.get("title"), 80).split(":", 1)[0].strip(),
                               display_text(envelope.get("title"), 80).split(":", 1)[0].split(",", 1)[0].strip())
            if title:
                return title
    if not title:
        if ask.intent == "metric":
            title = _METRIC_TITLES.get(ask.metric or "", "")
        elif ask.intent == "trend":
            title = _trend_title(ask)
        title = title or _INTENT_TITLES.get(ask.intent, "")
    return _first_fit(*_detailed(view, ask, title, final), title)


# --------------------------------------------------------------------------- #
# Round 13 polish: the one distinguishing detail a title may carry. Each is either
# made by the server (a lookup's window label, the case's display number, the
# console page a help answer points to, as the console map labels it) or validated
# against a closed grammar (a technique id in the ATT&CK corpus, a rule id), never free
# text from a log or a case. A rule id is a log-derived value: it rides only when the
# starter reference grammar accepts it unchanged, it is not shaped like an indicator,
# and it is shown exactly as written.
# --------------------------------------------------------------------------- #
_TITLE_MAX_WORDS = 6
#: A case's display number (the operator's template: "CASE-000045", "INC-2026-00042"):
#: letters and digits in up to five separated parts, at least one digit.
_TITLE_CASE_NUMBER_RE = re.compile(r"^[A-Za-z][A-Za-z0-9]{0,11}(?:[-_/.][A-Za-z0-9]{1,12}){0,4}$")
_TITLE_TECHNIQUE_RE = re.compile(r"^T\d{4}(?:\.\d{3})?$")
#: A detection rule id a title may name: the id characters the starter slots accept
#: for a reference (no space, quote, Markdown or marker character), at most 40.
_TITLE_RULE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,39}$")
_TITLE_MONTHS = ("January", "February", "March", "April", "May", "June", "July", "August", "September",
                 "October", "November", "December")
#: The window labels a title may carry, as the lookups word them (their dates in
#: brackets dropped): a closed grammar, so nothing but a window can ride along.
_TITLE_WINDOW_RE = re.compile(
    r"^(?:all time|today|yesterday|(?:this|last) (?:hour|week|month|quarter|year)"
    r"|last [1-9]\d? (?:minutes|hours|days|weeks|months|years)|last [1-9]\d{2} days"
    rf"|(?:{'|'.join(_TITLE_MONTHS)}) 20\d\d|Q[1-4] 20\d\d|W[0-5]?\d 20\d\d|20\d\d(?: to date)?"
    r"|(?:since|until) (?:[1-9]|[12]\d|3[01]) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) 20\d\d"
    r"(?: (?:[01]\d|2[0-3]):[0-5]\d)?)$")
#: Previous-period words for the relative windows a comparison names.
_TITLE_PREVIOUS = {"today": "yesterday", "this week": "last week", "this month": "last month",
                   "this quarter": "last quarter", "this year": "last year"}
_TITLE_WINDOW_SPECS = {"today": "today", "this_week": "this week", "this_month": "this month",
                       "this_quarter": "this quarter", "this_year": "this year"}
#: An indicator or entity KIND in a title (the value never is).
_TITLE_KINDS = {"ip": "IP address", "src_ip": "IP address", "source_ip": "IP address", "domain": "Domain",
                "url": "URL", "hash": "File hash", "file_hash": "File hash", "email": "Email address",
                "host": "Host", "user": "User", "keyword": "Keyword"}
_TITLE_LOG_KINDS = {"host": "Host", "user": "User", "ip": "IP", "src_ip": "IP", "source_ip": "IP",
                    "contains": "Keyword"}
#: A "my case" or one-case starter titled by its case number.
_STARTER_CASE_TITLES = {"needs_human": "{n} needs a person", "my_cases_one": "Next step on {n}",
                        "sla_breached_one": "{n} past its response target",
                        "sla_close_one": "{n} near its response target"}
#: Intents titled "<base>, <window>" (the window their main lookup read).
_WINDOWED_INTENTS = frozenset({
    "posture", "noise", "cost", "brute", "tp", "logs", "log_count", "top", "metric", "rate", "trend",
    "breakdown", "regroup_cases", "cases", "summary", "deep", "hunt", "entity_cases", "audit", "verdict_cases",
    "source_cases", "new_since", "these_open", "top_group_cases", "source_events", "regroup",
})


#: A response action's title by its verb (the closed list of response verbs).
_RESPONSE_TITLES = {
    "isolate": "Isolation request", "contain": "Containment request", "quarantine": "Quarantine request",
    "sinkhole": "Sinkhole request", "blackhole": "Blackhole request", "kill": "Kill request",
    "terminate": "Termination request", "block": "Block request", "unblock": "Unblock request",
    "ban": "Ban request", "lock out": "Account lockout request", "lock": "Lock request",
}


def _fits(title: str) -> bool:
    """A title the rules accept: 2 to 6 words, and what ``parse_title`` keeps as
    written (at most 48 characters, sentence case, no marker or quote)."""
    return bool(title) and 2 <= len(title.split()) <= _TITLE_MAX_WORDS and parse_title({"title": title}) == title


def _first_fit(*titles: str) -> str:
    return next((t for t in titles if t and _fits(t)), "")


def _title_case_number(view: PromptView) -> str:
    """The case's display number, as the case lookup returned it, when it reads as a
    number (never the internal id, never a long hex run)."""
    got = view.ok("get_case")
    case = _dig(got.obs, "case") if got else None
    number = case.get("case_number") if isinstance(case, Mapping) else None
    if not isinstance(number, str):
        return ""
    number = number.strip()
    if (not number or len(number) > 24 or number == str(case.get("case_id") or "")
            or not any(c.isdigit() for c in number) or not _TITLE_CASE_NUMBER_RE.fullmatch(number)
            or re.search(r"[0-9a-fA-F]{12,}", number)):
        return ""
    return number


def _title_technique(view: PromptView, ask: Ask) -> str:
    """The one ATT&CK technique asked about, when it is a technique id the bundled
    corpus (or this turn's ATT&CK lookup) knows."""
    asked = [t for t in ask.techniques if isinstance(t, str)] or [str(ask.slot("technique") or "")]
    if len(asked) != 1 or not _TITLE_TECHNIQUE_RE.fullmatch(asked[0]):
        return ""
    tid = asked[0]
    looked = view.ok("mitre_lookup")
    known = {str(t.get("id") or t.get("technique_id") or "") for t in (looked.obs.get("techniques") if looked
                                                                      else None) or [] if isinstance(t, Mapping)}
    if tid in known:
        return tid
    from . import mitre

    return tid if mitre.technique(tid) is not None else ""


#: Indicator kinds a rule id must not look like to ride in a title ("10.0.0.5",
#: "evil.com"): a title never repeats an indicator, whatever field it came from.
_TITLE_INDICATOR_KINDS = ("ip", "domain", "hash", "url", "email")


def _title_rule(value: Any) -> str:
    """A rule id a title may carry, exactly as written: it passes the title's rule
    characters and the starter reference grammar unchanged (which refuses a role
    marker such as ``SYSTEM:x``, look-alikes too), and it is not shaped like an IP
    address, domain, hash, URL or email address. Else ""."""
    if not isinstance(value, str) or not _TITLE_RULE_RE.fullmatch(value) or ref_value("rule", value) != value:
        return ""
    if any(entity_value(kind, value) is not None for kind in _TITLE_INDICATOR_KINDS):
        return ""
    return value


def _title_window_words(label: Any) -> str:
    """A window label as a title carries it ("last 30 days", "October 2026"), its
    bracketed dates dropped, or "" when it is not one of the window forms."""
    if not isinstance(label, str):
        return ""
    text = re.sub(r"^the ", "", label.split(" (", 1)[0].strip())
    short = re.fullmatch(r"(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (20\d\d)", text)
    if short:  # "Sep 2026" reads "September 2026", as the window label words it
        text = f"{next(m for m in _TITLE_MONTHS if m.startswith(short.group(1)))} {short.group(2)}"
    return text if _TITLE_WINDOW_RE.fullmatch(text) else ""


def _title_window(view: PromptView, ask: Ask) -> str:
    """The window the answer's main lookup read, as that lookup labelled it (else the
    planner's own phrase for the window asked), when it is a window form. Planner
    context lookups (the clock and the anchor) never name it."""
    tools = _INTENT_TOOLS.get(ask.intent, ())
    for result in view.results():
        if not result.ok or result.tool not in tools or _is_clock(result) or (
                result.input.get("window") == _ANCHOR_WINDOW and result.input.get("bucket") == "month"):
            continue
        words = _title_window_words(result.obs.get("window"))
        if words:
            return words
    return _title_window_words(ask.win.phrase) if ask.win is not None else ""


def _with_window(base: str, window: str) -> str:
    return f"{base}, {window}" if base and window else ""


def _upper(text: str) -> str:
    return text[:1].upper() + text[1:]


def _starter_title(view: PromptView, ask: Ask, starter: str) -> str:
    """A starter's curated title; a starter about one case, technique or rule names it
    (the number the case lookup returned, a corpus-known technique id, a rule id that
    passes the rule grammar), else the curated title alone."""
    curated = _STARTER_TITLES.get(starter, "")
    if starter in _STARTER_CASE_TITLES:
        number = _title_case_number(view)
        return _first_fit(_STARTER_CASE_TITLES[starter].format(n=number) if number else "", curated)
    if starter == "hunt":
        tid = _title_technique(view, ask)
        return _first_fit(f"ATT&CK hunt for {tid}" if tid else "", curated)
    if starter in ("noisy_rule", "noisy_rule_unnamed"):
        # The card without the rule's id names it here only once the lookup found ONE
        # rule (never one of several tied, PB5).
        pick = _noisy_rule_pick(view, ask) if starter == "noisy_rule_unnamed" else None
        rule = _title_rule(ask.slot("rule") if pick is None else (pick.rule if not pick.tied else ""))
        return _first_fit(f"Noisy rule {rule}" if rule else "", curated)
    if starter in ("new_cases", "new_cases_one"):
        window = _title_window(view, ask)
        return _first_fit(f"New cases {window}" if window.startswith("since ") else "", curated)
    return _first_fit(curated)


def _trend_title(ask: Ask) -> str:
    """A trend's title: the response-time measure asked about by name (MTTR, MTTA,
    MTTD: engine words picked from a closed list), else the subject's title."""
    if ask.subject == "timing":
        named = [m.upper() for m in ("mttr", "mtta", "mttd") if re.search(rf"\b{m}\b", ask.lowered)]
        if len(named) == 1:
            return f"{named[0]} trend"
    return _TREND_TITLES.get(ask.subject or "", "")


def _title_case_rule(case: Mapping[str, Any]) -> str:
    """The case's first detection rule id for its title, exactly as written, from the
    case's rule ids only (never its title, which is case text), when
    :func:`_title_rule` accepts it; else ""."""
    rules = [r for r in case.get("rules") or [] if isinstance(r, str)]
    return _title_rule(rules[0]) if rules else ""


def _title_console_page(view: PromptView, final: Final) -> str:
    """The console page a product-help answer points to first (an allowed page among
    its console links), as the bundled console map labels it ("Sources", "Single
    sign-on & policy"): server-made words from a closed set, so a title can say which
    page the help was about. The reference must name the page by the map's own
    breadcrumb, so nothing else can ride in."""
    allowed = {t.id: t for t in view.reference.targets if t.allowed}
    for target_id in final.console_links:
        target = allowed.get(target_id)
        crumb, label = _console_label(target_id)
        if target is not None and label and target.label == crumb:
            return label
    return ""


@functools.lru_cache(maxsize=256)
def _console_label(target_id: str) -> tuple[str, str]:
    """``(breadcrumb, label)`` of ``target_id`` in the bundled console map (empty when
    unknown or unreadable)."""
    try:
        from ..knowledge import get_app_knowledge

        target = get_app_knowledge().targets.get(target_id)
    except Exception:  # noqa: BLE001 -- a missing corpus only loses the detail
        return "", ""
    if target is None:
        return "", ""
    return str(getattr(target, "breadcrumb", "") or ""), str(getattr(target, "label", "") or "")


def _filter_noun(inp: Mapping[str, Any]) -> str:
    """Cases as a lookup's enumerated filters name them ("Open critical cases",
    "Escalated false positives", "My closed cases"): engine words for the status,
    severity and verdict values the tool accepted and "my" for the signed-in analyst's
    own cases, never a text, entity or named assignee filter."""
    words: list[str] = ["my"] if inp.get("assignee") == _ASSIGNEE_ME else []
    status = inp.get("status")
    group = inp.get("status_group")
    if isinstance(status, str) and status in (*OPEN_CASE_STATUSES, *TERMINAL_CASE_STATUSES):
        words.append(status.replace("_", " "))
    elif group == "active":
        words.append("open")
    elif group == "terminal":
        words.append("closed")
    severity = inp.get("severity")
    if isinstance(severity, str) and severity in ("critical", "high", "medium", "low", "info"):
        words.append(severity)
    verdict = str(inp.get("verdict") or "").upper()
    noun = {"FALSE_POSITIVE": "false positives", "TRUE_POSITIVE": "true positives"}.get(verdict, "cases")
    return _upper(" ".join([*words, noun])) if words or noun != "cases" else ""


def _first_input(view: PromptView, ask: Ask) -> Mapping[str, Any]:
    tools = _INTENT_TOOLS.get(ask.intent, ())
    found = next((r for r in view.results() if r.ok and r.tool in tools and not _is_clock(r)), None)
    return found.input if found is not None else {}


def _compare_titles(view: PromptView) -> list[str]:
    """"This month versus last month", "This month, year over year", "September 2026
    versus August 2026", else "Period comparison, last 30 days": the periods a
    comparison read, in window words."""
    found = next((r for r in view.results() if r.ok and _comparison_of(r.obs)), None)
    if found is None:
        return []
    spec, against = found.input.get("window"), found.input.get("compare")
    current = _TITLE_WINDOW_SPECS.get(spec) if isinstance(spec, str) else None
    now = _title_window_words(found.obs.get("window"))
    periods = (_comparison_of(found.obs) or {}).get("periods") or []
    before = _title_window_words(periods[0]) if periods else ""
    if current and (against == "previous_period" or (against == "same_period_last_year"
                                                     and current == "this year")):
        pair = f"{current} versus {_TITLE_PREVIOUS[current]}"
    elif current and against == "same_period_last_year":
        pair = f"{current}, year over year"
    else:
        pair = f"{now} versus {before}" if now and before and now != before else ""
    noun = _filter_noun(found.input)
    return [
        f"{noun}, {pair}" if noun and pair else "",  # "Medium cases, today versus yesterday"
        _upper(pair) if pair else "",
        _with_window("Period comparison", now),
    ]


def _detailed(view: PromptView, ask: Ask, base: str, final: Final | None = None) -> list[str]:
    """Titles with one distinguishing detail, best first (each must still fit)."""
    intent = ask.intent
    number = _title_case_number(view) if intent in (
        "case", "brief", "sla_case", "case_related", "case_entity", "pivot") else ""
    if intent in ("case", "brief"):
        got = view.ok("get_case")
        case = _dig(got.obs, "case") if got else None
        rule = _title_case_rule(case) if isinstance(case, Mapping) else ""
        # An id of digits alone reads as a rule only when it says so ("rule 100121").
        named = rule if re.search(r"[A-Za-z]", rule) else f"rule {rule}" if rule else ""
        if number:
            # The number leads: a narrow history rail cuts a title after about 26
            # characters, and the number is what tells two cases of one rule apart.
            if intent == "brief":
                return [f"{number} brief, {named}" if named else "", f"{number} investigation brief"]
            return [f"{number} {named} case" if named else "", f"{number} investigation"]
        return [f"Rule {rule} {'brief' if intent == 'brief' else 'case'}" if rule else ""]
    if intent in ("help", "change") and final is not None:
        # Product help names the console page it points to ("Data sources help").
        page = _title_console_page(view, final)
        return [f"{page} {'help' if intent == 'help' else 'change'}" if page else ""]
    if intent == "respond":
        # The action asked, from the response verbs' closed list ("Isolation request").
        action = _acting(ask.lowered)
        verb = action.group("verb") if action is not None else ""
        return [_RESPONSE_TITLES.get(verb, "")]
    if intent == "out_of_scope":
        kind = _out_of_scope(ask.lowered)
        return [{"code": "Code request, outside chat", "creative": "Creative writing, outside chat"}.get(
            kind or "", "")]
    if number:
        return [{"sla_case": f"{number} response target", "case_related": f"Cases related to {number}",
                 "case_entity": f"{number} entity activity", "pivot": f"Hunt from {number}"}[intent]]
    if intent in ("technique_hunt", "technique_cases", "mitre"):
        tid = _title_technique(view, ask)
        if tid:
            return [{"technique_hunt": f"ATT&CK hunt for {tid}", "technique_cases": f"Cases with {tid}",
                     "mitre": f"ATT&CK technique {tid}"}[intent]]
        return []
    if intent == "compare":
        return _compare_titles(view)
    if intent == "explain_metric" and ask.topic in {term[2] for term in _METRIC_TERMS}:
        return [f"{_upper(ask.topic)} explained"]
    if intent not in _WINDOWED_INTENTS:
        return []
    window = _title_window(view, ask)
    subject = base
    if intent == "hunt" and ask.indicator:
        kind = _TITLE_KINDS.get(str(ask.indicator[1]))
        subject = f"{kind} hunt" if kind else base
    elif intent in ("deep", "entity_cases") and ask.entity:
        kind = _TITLE_KINDS.get(str(ask.entity[0]))
        if kind:
            subject = f"{kind} deep dive" if intent == "deep" else f"{kind} cases"
    elif intent == "logs" and ask.log_filter:
        kind = _TITLE_LOG_KINDS.get(str(ask.log_filter[0][0]))
        subject = f"{kind} log search" if kind else base
    elif intent == "top" and ask.field in _FIELD_LABEL and ask.field not in ("severity", "action"):
        label = _FIELD_LABEL[ask.field]
        subject = f"Top {label}s" if not label.endswith("s") else f"Top {label}"
    elif intent == "cases":
        subject = _filter_noun(_first_input(view, ask)) or base
    elif intent in ("breakdown", "regroup_cases") and base.startswith("Cases ") and (ask.group or ask.bucket):
        # "Open cases by severity", "True positives per month": the filters the
        # lookup applied, then the dimension.
        noun = _filter_noun(_first_input(view, ask))
        subject = f"{noun} {base[len('Cases '):]}" if noun else base
    elif intent in ("breakdown", "regroup_cases") and not (ask.group or ask.bucket):
        # A count: "Critical case count", "False positive count".
        noun = _filter_noun(_first_input(view, ask))
        subject = (f"{noun[:-len(' cases')]} case count" if noun.endswith(" cases")
                   else f"{noun[:-1]} count" if noun else "Case count")
    # "My …" says whose cases they are, which tells conversations apart more than the
    # window does when both do not fit.
    mine = subject if subject.startswith("My ") else ""
    titles = [_with_window(subject, window), mine, _with_window(base, window), subject]
    rule = _title_rule(ask.rule) if intent == "breakdown" and ask.rule else ""
    if rule:
        # "Investigate rule X" (PB6) is about that rule, named as the title rules allow.
        titles.insert(0, f"Rule {rule} cases")
    return titles


#: Breakdown titles for the groupings a "Cases by …" title would not read well for.
_GROUP_TITLES = {"closed_by": "Who closed the cases", "decided_by": "Who decided the cases",
                 "mitre_technique": "Cases by ATT&CK technique", "mitre_tactic": "Cases by ATT&CK tactic",
                 "status_group": "Open and closed cases"}


def _specific_title(view: PromptView, ask: Ask) -> str:
    """A title that names what this conversation is about where the intent alone is
    generic (T6): the breakdown's dimension ("Cases by severity"); a case or brief is
    named by :func:`_detailed` (its rule and number). Engine words only."""
    if ask.intent in ("breakdown", "regroup_cases"):
        if ask.group in _GROUP_TITLES:
            return _GROUP_TITLES[ask.group]
        if ask.group:
            return f"Cases by {_DIMENSION_WORDS.get(ask.group, ask.group.replace('_', ' '))}"
        if ask.bucket:
            return f"Cases per {ask.bucket}"
    return ""


def _final_top_entity(view: PromptView, ask: Ask) -> Final | None:
    kind = ask.field or "host"
    ranking = _ranking(view)
    if ranking is None or not ranking.ok:
        return None
    value = _top_value(view, kind)
    noun = _ENTITY_NOUNS.get(kind, kind)
    if value is None:
        return Final(body=[f"That answer ranks no {noun} any more: the same lookup, run again now, returned none."])
    rows = _dig(ranking.obs, "top", kind) or []
    count = next((_num(r.get("count")) for r in rows if isinstance(r, Mapping) and r.get("value") == value), None)
    logs, cases = view.ok("search_logs"), view.ok("search_cases")
    # A ranking merged from per-source top lists counts each value as a lower bound;
    # the search of this turn has the exact count, so that one is stated as exact.
    merged = bool(ranking.obs.get("top_values_are_lower_bounds"))
    exact_logs = logs is not None and not _log_total_is_lower_bound(logs.obs)
    shown = "" if not count or (merged and exact_logs) else (
        f", with {'at least ' if merged else ''}{_plural(count, 'event')} {_in(_window(ranking.obs))}")
    # Values with the same count share the top: all are named, and the answer says it
    # follows the first listed (PB5).
    tied = [str(r.get("value")) for r in rows if isinstance(r, Mapping) and isinstance(r.get("value"), str)
            and r.get("value") != value and count is not None and _num(r.get("count")) == count]
    if tied:
        each = "" if not shown else shown.replace(_plural(count, "event"), _plural(count, "event") + " each", 1)
        lead = (f"{_code(value)} and {_peers([_code(t) for t in tied])} share the top of that answer{each}; this "
                f"answer follows {_code(value)}, listed first.")
    else:
        lead = f"The top {noun} in that answer is {_code(value)}{shown}."
    body = [lead]
    phrase = _entity_phrase(f"{kind}:{value}") if kind in ("ip", "user", "host") else _code(value)
    if cases is not None and ask.slot("cases_first"):
        body.append(_say_entity_cases(cases, phrase))
    if logs is not None:
        body.append("In the logs: " + _say_search_logs(logs))
    if cases is not None and not ask.slot("cases_first"):
        body.append(_say_entity_cases(cases, phrase))
    return Final(body=body, blocks=_keep(
        _block(cases, "case_list", view="case_list", title=f"Cases on the {noun}")
        if cases is not None and _num(cases.obs.get("count")) else None,
        _block(logs, "table", view="table", title="Matching log events")
        if logs is not None and _num(logs.obs.get("total")) else None,
    ))


def _final_entity_more(view: PromptView, ask: Ask) -> Final | None:
    logs, stats, cases = view.ok("search_logs"), view.ok("log_stats"), view.ok("search_cases")
    if logs is None and stats is None:
        return None
    phrase = _entity_phrase(f"{ask.field or 'ip'}:{ask.slot('value')}")
    body = [f"What {phrase} did {_in(_window(logs.obs if logs else stats.obs))}:"]
    if stats is not None:
        body.append(_say_log_stats(stats))
    elif logs is not None:
        body.append(_say_search_logs(logs))
    own = ask.slot("own_case")
    listed = [c for c in (cases.obs.get("cases") if cases is not None else None) or [] if isinstance(c, Mapping)]
    others = (int(_num(cases.obs.get("count")) or 0) - any(c.get("case_id") == own for c in listed)
              if cases is not None else 0)
    if cases is not None:
        body.append(_say_entity_cases(cases, phrase, exclude=own))
    return Final(body=body, blocks=_keep(
        _block(stats, "categories", view="hbar", title="Its log activity") if stats is not None else None,
        _block(logs, "table", view="table", title="Matching log events")
        if logs is not None and _num(logs.obs.get("total")) else None,
        _block(cases, "case_list", view="case_list",
               title="Cases on it, with this one" if own and any(c.get("case_id") == own for c in listed)
               else "Cases on it")
        if cases is not None and others > 0 else None,
    ))


def _final_these_open(view: PromptView, ask: Ask) -> Final | None:
    found = view.ok("search_cases")
    if found is None and ask.slot("case_scope") and view.ok("get_case") is not None:
        return Final(body=["This case names no main entity, so no other case is linked to it."])
    if found is None:
        if _closed_only(_these_open_prior(view)):
            return Final(body=["None of those cases is still open: the list above holds closed cases only."])
        return None
    total = int(_num(found.obs.get("count")) or 0)
    owners = view.ok("case_stats")
    if not total:
        return Final(body=["None of those cases is still open."])
    body = [f"**{_plural(total, 'case')}** of those {'is' if total == 1 else 'are'} still open."]
    groups = [g for g in (_stats_groups(owners.obs) if owners else []) if g.get("bucket") is None]
    if groups:
        parts = []
        for g in sorted(groups, key=lambda g: -(_num(_dig(g, "metrics", "count")) or 0))[:5]:
            who = _dig(g, "key", "assignee")
            who = "nobody (unassigned)" if not isinstance(who, str) or who.lower() in ("", "unassigned", "none") \
                else _code(who)
            parts.append(f"{who} {_count(_dig(g, 'metrics', 'count'))}")
        body.append("Who has them: " + _join(parts) + ".")
    body.extend(_case_bullets(found, limit=5))
    return Final(body=body, blocks=_keep(
        _block(found, "case_list", view="case_list", title="Still open"),
        _block(owners, "categories", view="hbar", title="Open cases by assignee") if owners is not None else None,
    ))


def _final_technique_cases(view: PromptView, ask: Ask) -> Final | None:
    technique = ask.techniques[0] if ask.techniques else ""
    mitre = view.ok("mitre_lookup")
    counted = view.ok("case_stats", where=lambda r: r.input.get("group_by") == ["mitre_technique"])
    cases = view.ok("search_cases")
    if mitre is None and counted is None:
        return None
    rows = [t for t in (mitre.obs.get("techniques") if mitre else None) or [] if isinstance(t, Mapping)]
    row = next((t for t in rows if t.get("id") == technique), None)
    name = display_text(row.get("name"), 80) if row else ""
    subject = f"**{display_text(technique, 12)}{' ' + name if name else ''}**"
    body: list[str] = []
    if ask.slot("explain") and row is not None and row.get("description"):
        body.append(f"{subject}: {_plain(row.get('description'), 300)}")
        subject = display_text(technique, 12)
    if counted is not None:
        window = _window(counted.obs)
        count = int(sum((_num(_dig(g, "metrics", "count")) or 0) for g in _stats_groups(counted.obs)
                        if _dig(g, "key", "mitre_technique") == technique))
        rules = _technique_rules(view, technique)
        if count:
            body.append(f"{subject} appears in **{_plural(count, 'case')}** {_in(window)}"
                        + (f", from {_plural(len(rules), 'rule')}." if rules else "."))
            body.extend(_technique_cases_part(view, technique, count))
        else:
            body.append(f"{subject} appears in no case {_in(window)}.")
    return Final(body=body, blocks=_keep(
        _block(mitre, "mitre", view="mitre", title="ATT&CK technique"),
        *(_technique_case_blocks(view, technique) if cases is not None else []),
    ))


def _final_verdict_cases(view: PromptView, ask: Ask) -> Final | None:
    found = view.ok("search_cases")
    by_rule = view.ok("case_stats")
    if found is None and by_rule is None:
        return None
    verdict = str(ask.slot("verdict") or "FALSE_POSITIVE")
    noun = "false positive" if verdict.startswith("FALSE") else "true positive"
    o = (by_rule or found).obs
    total = int(_num(o.get("total")) if by_rule is not None else _num(found.obs.get("count")) or 0)
    window = _window(o)
    rule = ask.slot("rule")
    subject = f"{noun} {'case' if total == 1 else 'cases'}" + (f" from rule {_code(rule)}" if rule else "")
    if not total:
        return Final(body=[f"No {subject.replace('cases', 'case')} {_in(window)}."])
    body = [f"**{_count(total)} {subject}** {_in(window)}."]
    groups = sorted([g for g in (_stats_groups(by_rule.obs) if by_rule else []) if g.get("bucket") is None],
                    key=lambda g: -(_num(_dig(g, "metrics", "count")) or 0))
    if groups:
        top = groups[0]
        # Rules tied for the most are all named (PB5).
        tied = [g for g in groups[1:] if _count(_dig(g, "metrics", "count")) == _count(_dig(top, "metrics", "count"))]
        if tied:
            names = _peers([_code(_dig(g, "key", "rule")) for g in [top, *tied]], limit=4)
            body[0] = body[0].rstrip(".") + (f"; most came from rules {names} "
                                             f"({_count(_dig(top, 'metrics', 'count'))} each).")
        else:
            body[0] = body[0].rstrip(".") + (f"; most came from rule {_code(_dig(top, 'key', 'rule'))} "
                                             f"({_count(_dig(top, 'metrics', 'count'))}).")
    if found is not None and not ask.slot("by_rule"):
        body.extend(_case_bullets(found, limit=5))
    return Final(body=body, blocks=_keep(
        _block(by_rule, "categories", view="hbar", title=f"{noun.capitalize()}s by rule") if groups else None,
        _block(found, "case_list", view="case_list", title=f"{noun.capitalize()} cases")
        if found is not None and _num(found.obs.get("count")) else None,
    ))


def _final_top_group_cases(view: PromptView, ask: Ask) -> Final | None:
    stats, found = view.ok("case_stats"), view.ok("search_cases")
    if stats is None:
        return None
    dim = ask.group or "severity"
    groups = [g for g in _stats_groups(stats.obs) if g.get("bucket") is None]
    best = max(groups, key=lambda g: _num(_dig(g, "metrics", "count")) or 0, default=None)
    label = _dig(best, "key", dim) if best else None
    if found is None or not isinstance(label, str):
        return Final(body=[f"That breakdown has no single top {dim} to list cases for."])
    def name(value: Any) -> str:
        return _code(value) if dim in ("rule", "assignee", "source") else f"**{display_text(value, 40)}**"

    shown = name(label)
    # One sentence for the top group (its exact count), then its cases: the search's
    # own count would repeat the same figure (Round 13 copy review). Groups tied with it
    # are named, and the cases listed are the first one's (PB5).
    top_n = _count(_dig(best, "metrics", "count"))
    tied = [_dig(g, "key", dim) for g in groups if g is not best and _count(_dig(g, "metrics", "count")) == top_n
            and isinstance(_dig(g, "key", dim), str)]
    if tied:
        body = [f"{shown} and {_peers([name(t) for t in tied])} tie as the top {dim} {_in(_window(stats.obs))}, "
                f"with **{_plural(_dig(best, 'metrics', 'count'), 'case')}** each; the highest-risk cases of {shown}:"]
    else:
        body = [f"The top {dim} {_in(_window(stats.obs))} is {shown}, with "
                f"**{_plural(_dig(best, 'metrics', 'count'), 'case')}**; the highest risk of them:"]
    body.extend(_case_bullets(found, limit=5))
    return Final(body=body, blocks=_keep(_block(found, "case_list", view="case_list", title=f"Cases, top {dim}")))


def _final_source_events(view: PromptView, ask: Ask) -> Final | None:
    name = str(ask.slot("source") or "")
    row = _named_source(view, name)
    logs = view.ok("search_logs")
    if view.ok("source_health") is None:
        return None
    if row is None:
        # The configured sources by name, so the analyst can ask about the right one.
        health = view.ok("source_health")
        names = [_code(display_text(r.get("name"), 80)) for r in (health.obs.get("sources") if health else None) or []
                 if isinstance(r, Mapping) and r.get("name")]
        body = [f"No log source named {_code(name)} is configured, so there are no events to show."]
        if names:
            body.append(f"Configured sources: {_peers(names, limit=5)}.")
        return Final(body=body)
    shown = _code(display_text(row.get("name"), 80))
    # Its health, when something is wrong with it (silent, a failed poll, disabled).
    state = [w for w, on in (("silent", row.get("silent")), ("disabled", not row.get("enabled", True))) if on]
    health_line = ([f"{shown} is {_join(state)}."] if state else []) + (
        [f"The last poll of {shown} failed."] if row.get("last_poll_failed") else [])
    if logs is None:
        return Final(body=[*health_line, f"The events of {shown} could not be read."])
    return Final(body=[*health_line, f"Recent events from {shown}: " + _say_search_logs(logs)], blocks=_keep(
        _block(logs, "table", view="table", title="Recent events") if _num(logs.obs.get("total")) else None,
        _block(logs, "series", view="bar", title="Events over time") if _num(logs.obs.get("total")) else None,
    ))


def _final_source_cases(view: PromptView, ask: Ask) -> Final | None:
    stats = view.ok("case_stats", where=lambda r: r.input.get("group_by") == ["source"])
    if stats is None:
        return None
    name = display_text(ask.slot("source"), 120)
    row = _named_source(view, name)
    groups = _stats_groups(stats.obs)
    total = _num(_dig(stats.obs, "totals", "count"))
    where = _in(_window(stats.obs)) if _window(stats.obs) else "over all time"
    if row is None:
        body = [f"No configured log source is named {_code(name)} now, so no case can be counted for it."]
    else:
        keys = {str(row.get("source_id") or "").lower(), str(row.get("name") or "").strip().lower()} - {""}
        count = sum((_num(_dig(g, "metrics", "count")) or 0) for g in groups
                    if str(_dig(g, "key", "source") or "").strip().lower() in keys)
        body = [f"**{_plural(count, 'case')}** came from {_code(row.get('name') or name)} {where}"
                + (f", of {_count(total)} in all." if total is not None else ".")]
        if count and len(groups) > 1:
            body.append("Chat's case lookups count cases by source but cannot list one source's cases; the chart "
                        "shows every source side by side.")
    return Final(body=body, blocks=_keep(_block(stats, "categories", view="hbar", title="Cases by source")))


_FINALS: dict[str, Callable[[PromptView, Ask], Final | None]] = {
    "posture": _final_posture, "noise": _final_noise, "metric": _final_metric, "shift": _final_shift,
    "cost": _final_cost, "top": _final_top, "brute": _final_brute, "tp": _final_tp, "case": _final_case,
    "logs": _final_logs, "log_count": _final_log_count,
    "hunt": _final_hunt, "pivot": _final_pivot, "mitre": _final_mitre, "sources": _final_sources,
    "campaigns": _final_campaigns, "cases": _final_cases, "help": _final_help,
    "explain_metric": _final_explain_metric, "change": _final_change, "unsupported": _final_unsupported,
    "respond": _final_respond, "out_of_scope": _final_out_of_scope,
    "remember": _final_remember, "reshape": _final_reshape, "rerun": _final_rerun,
    "explain_step": _final_explain_step, "rerun_step": _final_rerun_step,
    "regroup": lambda v, a: _final_regroup(v, a), "empty": _final_empty,
    "breakdown": _final_breakdown, "trend": _final_trend, "compare": _final_compare,
    "perf_report": _final_perf_report, "brief": _final_brief, "deep": _final_deep, "clarify": _final_clarify,
    "summary": _final_summary, "rate": _final_rate, "entity_cases": _final_entity_cases,
    "automation": _final_automation,
    # Round 13 starters (SPEC-chat §3.4, §3.14).
    "sla_case": _final_sla_case, "my_cases": _final_my_cases, "sla": _final_sla, "new_since": _final_new_since,
    "volume": _final_volume, "noisy_rule": _final_noisy_rule, "campaign": _final_campaign, "source": _final_source,
    "budget": _final_budget, "approvals": _final_approvals, "auto_close": _final_auto_close, "triage": _final_triage,
    "technique_hunt": _final_technique_hunt, "case_entity": _final_case_entity, "case_related": _final_case_related,
    # Round 13 follow-up chips (T4).
    "top_entity": _final_top_entity, "entity_more": _final_entity_more, "these_open": _final_these_open,
    "compare_cases": _final_compare_cases,
    "regroup_cases": _final_breakdown,
    "technique_cases": _final_technique_cases, "verdict_cases": _final_verdict_cases,
    "top_group_cases": _final_top_group_cases, "source_events": _final_source_events,
    "source_cases": _final_source_cases,
}
_FINALS["case"] = _final_starter_case
#: The intents whose answer a rerun ("Show the same for all time") keeps: the same
#: lookups re-ran, so the earlier question's own final narrates them.
_RERUN_FINALS: dict[str, Callable[[PromptView, Ask], Final | None]] = {
    intent: _FINALS[intent] for intent in ("summary", "breakdown", "cases", "tp", "trend", "top", "logs",
                                           "log_count", "cost", "posture", "metric", "noise")
}
# A comparison re-run over a new window ("Show the same for the last 30 days") reads as
# a comparison; re-run without one ("… for all time") it reads as the counts it is.
_RERUN_FINALS["compare"] = lambda view, ask: _final_compare(view, ask) if any(
    _comparison_of(r.obs) for r in view.results() if r.ok) else None


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


#: Lookups that read many cases at once: a "my cases" answer from any of them that
#: carried no assignee "me" covers every case, and says so (Round 13 polish).
_QUEUE_TOOLS = frozenset({"search_cases", "case_stats", "shift_report", "soc_metrics", "list_campaigns"})


def _mine_note(view: PromptView, ask: Ask, final: Final) -> str:
    """The sentence for a "my cases" question whose lookups could not be narrowed to
    the signed-in analyst's own cases (the shift snapshot, the metrics), else "". A
    lookup by case id, or an answer that already says it, needs none."""
    if not ask.mine:
        return ""
    read = [r for r in view.results() if r.ok and r.tool in _QUEUE_TOOLS and not _is_clock(r)]
    if not read or any(_is_my_search(r) for r in read):
        return ""
    if any("which cases are yours" in line for line in final.body):
        return ""
    if all(r.tool == "shift_report" for r in read):
        return "The shift snapshot cannot tell which cases are yours, so it covers every open case, not only yours."
    return "These figures cannot be narrowed to the cases assigned to you, so they cover every case, not only yours."


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
    if chip.strip().lower() == "all time":
        # "the all time you selected" is not English: name the All time chip a range.
        chip = "all-time range"

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
    if ask.win is not None and ask.win.spec is not None and _same_as_chip(ask.win, view.analyst_window):
        # The question names the very window the chip selected ("in total" with All
        # time, "the last 6 months" with 6mo): nothing replaced anything.
        return f"Window: the {chip} you selected applies to the windowed lookups above."
    if ask.win is not None and ask.win.spec is not None:
        if _minutes_note(view, ask):
            # The minutes note right after says which lookups rounded it to whole hours.
            return f"Window: your question named {ask.win.phrase}, which replaces the {chip} you selected."
        return (f"Window: your question named {ask.win.phrase}, so the lookups used that window "
                f"instead of the {chip} you selected.")
    return f"Window: the {chip} you selected applies to the windowed lookups above."


def _canonical_window(spec: Any) -> str | None:
    """A comparable form of a window spec: ``all``, or a trailing span in one unit per
    kind (years as months, weeks and days as hours), so ``now-1y`` equals ``now-12M``
    and ``now-1d`` equals ``now-24h``. ``None`` for anything else."""
    if not isinstance(spec, str):
        return None
    token = spec.strip()
    if token.lower() == "all":
        return "all"
    match = re.fullmatch(r"now-(\d+)([mhdwMy])", token)
    if not match:
        return None
    amount, unit = int(match.group(1)), match.group(2)
    if unit == "y":
        amount, unit = amount * 12, "M"
    elif unit == "w":
        amount, unit = amount * 7, "d"
    if unit == "d":
        amount, unit = amount * 24, "h"
    return f"now-{amount}{unit}"


def _same_as_chip(win: Win, chip: str | None) -> bool:
    """Whether the window the question names is the one the analyst's time chip
    selected (the chip's label read back with the planner's own window grammar)."""
    if not chip:
        return False
    selected = _window_from(chip.strip().lower())
    if selected is None:
        return False
    if win.all_time or selected.all_time:
        return bool(win.all_time and selected.all_time)
    mine, theirs = _canonical_window(win.spec), _canonical_window(selected.spec)
    return mine is not None and mine == theirs


def _minutes_note(view: PromptView, ask: Ask) -> str:
    """A window in minutes reaches case, metric and cost lookups as whole hours."""
    if ask.win is None or not isinstance(ask.win.spec, str) or not re.fullmatch(r"now-\d+m", ask.win.spec):
        return ""
    if not any(r.ok and r.tool not in _LOG_WINDOW_TOOLS and r.tool not in _REFERENCE_TOOLS for r in view.results()):
        return ""
    hours = ask.win.hours or 1
    span = "hour" if hours == 1 else f"{hours} hours"
    logs = any(r.ok and r.tool in _LOG_WINDOW_TOOLS for r in view.results())
    return (f"Case, metric and cost lookups count whole hours, so they cover the last {span} rather than "
            f"{ask.win.phrase}" + (f"; log lookups use {ask.win.phrase} exactly." if logs else "."))


def _period_note(final: Final, ask: Ask) -> str:
    """A period the question named that the lookups could not use (one that could not
    be dated, or a time phrase the planner could not read): said once, never dropped
    silently (routing.md §5.16)."""
    if ask.intent not in _ANCHOR_INTENTS or not (ask.undated or ask.unread):
        return ""
    if any("could not be dated" in line or "as a period" in line for line in final.body):
        return ""
    if ask.undated:
        return (f"{ask.undated} could not be dated (the lookup that reads the current month did not answer), so "
                "each figure covers the window its lookup states.")
    return (f"I could not read “{_plain(ask.unread, 60)}” as a period, so each figure covers the window its lookup "
            "states.")


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


#: Intents whose answer is never wrapped into a report envelope: the shift brief
#: builds its own, and a question ABOUT reports ("How do reports work?"), a change
#: request, a clarify or an unsupported ask carries no findings to report on.
_NO_REPORT_INTENTS = frozenset({"shift", "help", "explain_metric", "change", "unsupported", "remember", "empty",
                                "clarify", "respond", "out_of_scope"})


_OUTSIDE_RANGE_TEXT = "wholly outside the selected time range"


def _final_outside_range(view: PromptView, ask: Ask) -> Final | None:
    """The period the question named lies wholly outside the analyst's time chip: every
    lookup over it was refused, so the answer says so and how to widen the range
    (never the whole chip's figures presented as that period's)."""
    if not view.analyst_window or ask.win is None or ask.win.spec is None:
        return None
    refused = [r for r in view.failed() if _OUTSIDE_RANGE_TEXT in f"{r.summary} {r.error or ''}"]
    if not refused:
        return None
    if any(r.ok and r.tool not in _REFERENCE_TOOLS and not _is_anchor_call(r) for r in view.results()):
        return None  # partly answered: the failure lines name what was refused
    chip = display_text(view.analyst_window, 60)
    period = ask.win.phrase[:1].upper() + ask.win.phrase[1:]
    return Final(body=[f"{period} is outside the {chip} you selected, so there is nothing to show for it. Widen "
                       f"the selected time range, or clear it, to look at {ask.win.phrase}."],
                 narrated={r.ordinal for r in refused},
                 follow_ups=[f"Show the same for the {chip}" if chip.startswith("last ") else
                             "How many cases are open right now?",
                             "How is our security posture right now?", "Compare this month with last month"])


def _compose_final(view: PromptView, ask: Ask) -> Final:
    if view.legacy is not None:
        return _final_legacy(view, ask)
    if not view.granted and ask.intent not in ("remember", "empty", "reshape", "explain_step", "respond",
                                               "out_of_scope"):
        return _final_no_tools(view, ask)
    builder = _FINALS.get(ask.intent)
    final = _final_outside_range(view, ask)
    if final is None:
        final = builder(view, ask) if builder is not None else None
    generic = final is None
    if final is None:
        final = _final_generic(view, ask)
    if (not view.case_scoped and ask.report and ask.intent not in _NO_REPORT_INTENTS
            and any("ref" in b for b in final.blocks) and not any(b.get("type") == "report" for b in final.blocks)):
        # Wrapped first, so the report's lead replaces the narration while the notes
        # (what is missing, what failed, the window) still follow it. A generic final
        # carries its own notes (:attr:`Final.notes`); for the others they are added
        # below.
        if ask.report == "custom" and not re.search(r"\bcustom\b", ask.lowered):
            # "a report on case X" names no template: the intent's own one fits best.
            ask = replace(ask, report=_INTENT_TEMPLATES.get(ask.intent, "custom"))
        final = _as_report(
            final, view, ask, title=_report_title(view, ask),
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
            # A handoff note or a brief the planner builds on its own is no report
            # request: only "… report …" earns the pointer to Workspace Reports.
            final = _unwrap_report(final, asked=bool(re.search(r"\breports?\b", ask.lowered)))
    if view.unrun:
        final.body.append("The question reached its time limit before the remaining lookups ran, so this answer "
                          "uses only the lookups that completed.")
    elif view.final_only and not view.results() and ask.intent in _DATA_INTENTS:
        final.body.append("Tool use was closed for this question before any lookup ran, so no data backs this "
                          "answer. Ask again or narrow the question.")
    window_note = _window_note(view, ask)
    if window_note:
        final.body.append(window_note)
    mine_note = _mine_note(view, ask, final)
    if mine_note:
        final.body.append(mine_note)
    period_note = _period_note(final, ask)
    if period_note:
        final.body.append(period_note)
    minutes_note = _minutes_note(view, ask)
    if minutes_note:
        final.body.append(minutes_note)
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
    if final.clarify is None:
        # Round 13 (SPEC-chat §4.1, T4): chips about what this answer shows.
        final.follow_ups = _anchored_follow_ups(view, ask, final)
    final.title = _conversation_title(view, ask, final)
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
    if final.title:
        header["title"] = final.title
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
        # The final reads the DATED ask (a named month or quarter with its year) and a
        # view without the anchor lookup that dated it.
        final = _compose_final(_without_anchor(view, ask), _resolved(view, ask))
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
    if unit == "score":
        return _score(number)
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
                # The largest category leads; categories tied with it lead together (PB5).
                best = max((_num(c.get("value")) for c in categories if _num(c.get("value")) is not None),
                           default=None)
                tops = [c for c in categories if best is not None and _num(c.get("value")) == best] or categories[:1]
                names = [_plain(c.get("label"), 60) or "an unnamed value" for c in tops]
                value_text = _digest_value(tops[0].get("value"), leaf.get("unit"))
                leaders.append(f"{_plain(leaf.get('title'), 60) or 'a chart'} is led by {names[0]} ({value_text})"
                               if len(tops) == 1 else
                               f"{_plain(leaf.get('title'), 60) or 'a chart'} is led jointly by "
                               f"{_peers(names)} ({value_text} each)")
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
    # Round 13 T37: every step comes from the report's own figures (its severities,
    # open cases, leading categories and trends), never a fixed checklist.
    steps: list[str] = []
    urgent = [(s, severity.get(s)) for s in ("critical", "high") if severity.get(s)]
    if urgent:
        steps.append("Review the " + _join([f"{_count(n)} {s}" for s, n in urgent])
                     + f" {'case' if sum(n for _s, n in urgent) == 1 else 'cases'} first.")
    if open_cases:
        steps.append(f"Confirm an owner for the {_plural(open_cases, 'open case')} in this report.")
    for leader in leaders[:1]:
        steps.append(f"Look into why {leader}.")
    for trend in trends[:1]:
        steps.append(f"Find out why {trend}.")
    if sampled or truncated:
        steps.append("Re-run the sampled or top-N lookups with a narrower filter before acting on them.")
    if notes:
        steps.append(f"Check the {_plural(notes, 'analyst note')} against the data before sharing.")
    if not steps:
        steps.append(f"Add the figures behind the {_plural(count, 'item')} (a chart or key figures) and "
                     "regenerate this summary." if count else "Add items to the report, then regenerate this summary.")
    return json.dumps({"executive_summary": summary, "next_steps": steps[:5]}, ensure_ascii=True)
