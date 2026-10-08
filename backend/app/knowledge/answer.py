"""Deterministic product help at $0 (chat revamp SPEC §5.4.1).

"How do I configure a model?" is asked precisely when no model works. When the first
model call of a turn cannot run — no provider (or only the legacy mock), the budget
gate blocked it, the breaker is open, the key was rejected — and the message is a
product question, the engine answers extractively instead of failing:

    From the Help Center (0.1): <the top section's first sentences> [D1]

with ``D*`` citations, console links (``allowed`` from the caller's grants), a guide
block of where to go (the numbered steps stay in the Markdown answer, once),
``answer_kind="product_help"``, zero usage and a notice naming why the AI was not used.
A message is a product question only with a product cue and no data signal (a case id,
an address, a time window, "how many", "show me", …; see :func:`classify_intent`): a
data question asked while the AI is unavailable gets the plain notice, never docs. A question naming a settings key (``poll_batch_size``, ``rag.top_k``) is answered
from the code-derived ``settings_schema()`` defaults and the section that owns the key.

Nothing here calls a model, writes, or reads tenant data; it is pure over the bundled
corpus, so it behaves the same in Demo Mode and with no LLM configured.
"""

from __future__ import annotations

import functools
import re
from dataclasses import dataclass, field
from typing import Any, Iterable, Literal

from ..agents.blocks import validate_blocks
from ..models import ChatResponse, Citation, ConsoleLink, TurnNotice, TurnUsage
from .corpus import AppKnowledge, ConsoleTarget, DocChunk, get_app_knowledge
from .render import (
    chunk_title,
    console_link,
    doc_citation,
    doc_href,
    first_sentences,
    split_procedure,
    target_allowed,
)

# --------------------------------------------------------------------------- #
# Routing: is this message a product question? (§5.4.1)
# --------------------------------------------------------------------------- #
# Without a model, a misrouted DATA question would get an irrelevant Help Center answer
# labelled "Product help" in place of the plain notice that the AI is unavailable, which
# misleads more than it helps. So routing needs positive product intent AND no data
# intent: the BM25F score alone cannot decide, because data questions share nouns
# ("cases", "auto-close", "false positive rate") with product prose and reach 8-17.
#
# Strong cues ask how to operate the product or what a term means; they outweigh the
# soft data signals below ("what does the Open Cases KPI count?" is a product question)
# but never a hard one ("how can I see failed logins from the last hour?" wants data).
_STRONG_CUE_RE = re.compile(
    r"^\s*/help\b"
    r"|\bhow\s+(?:do|can|could|should|would|will|may|might)\s+"
    r"(?:i|we|you|one|someone|an?\s+(?:admin|administrator|analyst|operator|user))\b"
    r"|\bhow\s+to\b|\bis\s+there\s+a\s+way\s+to\b"
    r"|\bwhere\s+(?:do|can|could|should|would|will)\s+(?:i|we|you|one)\b"
    r"|\b(?:help\s+center|documentation|docs)\b"
    r"|\bwhat\s+(?:does|do)\b[^?]*?\b(?:mean|stand\s+for|measure|represent|control)\b"
    # "show", "count", "include" also describe data ("what do the logs show?"), so they
    # are a definition only after a product noun ("what does the Open Cases KPI count?").
    r"|\bwhat\s+(?:does|do)\b[^?]*?\b(?:kpi|tile|card|metric|chart|column|field|setting|badge|status"
    r"|label|widget|funnel|gauge|button|toggle|switch|option|page|tab|role|permission|panel|filter"
    r"|view|score|index|rate|timing)s?\s+(?:show|count|include|cover|indicate|do)\b"
    r"|\bhow\s+(?:does|do|is|are)\b[^?]*?\b(?:work|calculated|computed|measured|derived|decided"
    r"|determined|scored|attribute|attributed|counted|defined|enforced|limited|relate|differ)\b"
    r"|\b(?:what\s+is\s+meant\s+by|meaning\s+of|definition\s+of|define|differences?\s+between"
    r"|what's\s+the\s+difference)\b",
    re.IGNORECASE,
)
# Product cues: a product noun or an imperative about configuring the product. They
# make a message eligible but never outweigh a data signal.
_PRODUCT_CUE_RE = re.compile(
    r"\b(?:settings?|preferences?|permissions?|roles?|rbac|menus?|pages?|tabs?|buttons?|wizard"
    r"|sidebar|navigation|console|options?|toggles?|features?)\b"
    r"|^\s*(?:please\s+)?(?:(?:help\s+me|i\s+(?:want|need|would\s+like)\s+to|i'd\s+like\s+to)\s+)?"
    r"(?:configure|set\s*up|setup|enable|disable|turn\s+(?:on|off)|install|upgrade|add|connect"
    r"|integrate|invite|rotate|reset|change|create|rename|import|export|customi[sz]e|onboard"
    r"|register|revoke|grant|switch)\b",
    re.IGNORECASE,
)
# Weak cues: question shapes shared with data questions ("what is…", "why was…").
_WEAK_CUE_RE = re.compile(
    r"\b(?:what\s+(?:is|are|was|were|happens|does|do)|what's|whats|where\s+(?:is|are)"
    r"|why\s+(?:did|does|do|was|is|are|would|can't|cannot)|explain|tell\s+me\s+about"
    r"|is\s+there|can\s+i|which|how\s+(?:does|do|is|are))\b"
    r"|^\s*help\b",
    re.IGNORECASE,
)
# Hard data signals: the message names a specific case, address, hash or domain, or
# points at the object in view ("this alert"). No cue outweighs them: the user wants
# that object's data, not the manual.
_ENTITY_RE = re.compile(
    r"\b(?:case|inc|incident|alert|ticket|cluster|campaign)[-_ #]?\d+\b"
    r"|#\d{2,}\b"
    r"|\b(?:\d{1,3}\.){3}\d{1,3}\b"
    r"|\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{0,4}\b"
    r"|\b(?:[a-f0-9]{32}|[a-f0-9]{40}|[a-f0-9]{64})\b"
    r"|\bhttps?://"
    r"|\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b"
    r"|\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|net|org|io|info|biz|xyz|top|ru|cn|co"
    r"|uk|de|fr|in|us|gov|edu|mil|local|internal|corp|lan|onion|online|site|cloud)\b"
    r"|\b(?:this|that|these|those)\s+(?:case|alert|incident|event|host|ip|user|account|cluster"
    r"|entity|detection|log|finding|campaign|ticket|ioc|indicator|attack|activity|spike)s?\b",
    re.IGNORECASE,
)
# Data signals: a time window, a listing or aggregation request, or activity words. No
# cue outweighs them either.
_DATA_SIGNAL_RE = re.compile(
    r"\b(?:last|past|previous)\s+(?:\d+\s*)?(?:minutes?|mins?|hours?|hrs?|h|days?|d|weeks?|wks?|w"
    r"|months?|night|shift|quarter|year)\b"
    r"|\b\d+\s*(?:mins?|minutes?|h|hrs?|hours?|d|days?|w|wks?|weeks?)\s+ago\b"
    r"|\b(?:today|tonight|yesterday|overnight)\b"
    r"|\bthis\s+(?:morning|afternoon|evening|week|month|quarter|year|shift)\b"
    r"|\bsince\s+(?:yesterday|last|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d)"
    r"|^\s*(?:please\s+|can\s+you\s+|could\s+you\s+)?(?:show|list|find|get|give|fetch|pull|display"
    r"|summari[sz]e|count|investigate|triage|analy[sz]e|hunt|search|look\s*up|check|query"
    r"|correlate|enrich|block|isolate|quarantine)\b"
    r"|\bshow\s+me\b|\bhow\s+many\b"
    r"|\b(?:top|bottom)\s+(?:\d+|source|destination|talkers?|users?|hosts?|ips?|ip\s+addresses"
    r"|rules?|alerts?|countries|domains?|ports?|entities|accounts?|attackers?|offenders?"
    r"|signatures?|events?|cases?)\b"
    r"|\bmost\s+(?:common|frequent|active|targeted|critical|noisy|seen|affected)\b"
    r"|\b(?:latest|recent|newest|currently|right\s+now|so\s+far)\b"
    r"|\bany\s+(?:[\w-]+\s+){0,3}?(?:activity|alerts?|events?|attempts?|incidents?|detections?"
    r"|hits?|traffic|log-?ins?|cases?|threats?|attacks?|malware|phishing|anomal(?:y|ies))\b"
    r"|\b(?:were|are)\s+there\s+any\b"
    r"|\b(?:did|have|has)\s+(?:we|you|the\s+agent|anyone|someone|anybody|it)\s+(?:see|seen|get|got"
    r"|had|have|detect(?:ed)?|find|found|close[ds]?|escalated?|investigated?|block(?:ed)?"
    r"|receive[ds]?)\b"
    r"|\bwho\s+(?:closed|opened|assigned|escalated|changed|acknowledged|approved|resolved|owns"
    r"|is\s+assigned|logged|accessed|deleted|edited)\b"
    r"|\bwhat\s+happened\b|\b(?:so|too)\s+(?:many|much|high|low|few|slow)\b"
    r"|\b(?:spikes?|surges?|bursts?|failed\s+log-?ins?|log-?in\s+(?:failures|attempts?))\b",
    re.IGNORECASE,
)
# Soft data signals: a filtered set of cases or a metric of "our"/"my" estate. A strong
# cue outweighs them, because KPI and glossary questions name the same sets.
_SOFT_DATA_RE = re.compile(
    r"\b(?:open|closed|critical|high|medium|low|new|unassigned|escalated|pending|active|assigned"
    r"|resolved|unresolved|stale|overdue)\s+(?:severity\s+)?(?:cases|alerts|incidents|events"
    r"|detections|tickets|findings)\b"
    r"|\b(?:our|my)\s+(?:[\w-]+\s+){0,2}?(?:rates?|scores?|mttd|mtta|mttr|dwell|spend(?:ing)?|costs?"
    r"|posture|coverage|backlog|queue|volume|numbers|trends?|exposure|alerts|cases|incidents"
    r"|detections|tickets|tasks|workload|sla|performance|stats|statistics|metrics)\b",
    re.IGNORECASE,
)

IntentClass = Literal["data", "settings_key", "strong", "product", "weak", "none"]
# The BM25F floor each class must clear. A strong or product cue needs only a modest
# match (the cue already says "product"); a weak cue needs a clearer one. A message with
# no cue never routes: a bare noun phrase is as likely to be a data request. A product
# or weak cue also needs every word of the message to occur somewhere in the Help
# Center: "tell me about jdoe" or "add user jdoe" names something the manual never
# mentions (an account, a host), so it is about data or an action, not the product.
ROUTE_FLOORS: dict[str, float] = {"strong": 4.0, "product": 4.0, "weak": 5.0}
# Prose that scores below this beside an answered settings key only shares a word with it.
SETTINGS_PROSE_FLOOR = 12.0
# A Preferences key mentioned in prose: ``poll_batch_size``, ``rag.top_k``, ``chat_model``.
_SETTING_KEY_RE = re.compile(r"`?\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+|[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)\b`?")

UnavailableReason = Literal["not_configured", "unauthenticated", "budget", "breaker", "quota", "unavailable"]

_NOTICES: dict[str, tuple[str, str, bool]] = {
    "not_configured": ("provider", "AI answers are unavailable: no model is configured or its key was rejected. This answer comes from the Help Center at no cost.", False),
    "unauthenticated": ("provider", "AI answers are unavailable: no model is configured or its key was rejected. This answer comes from the Help Center at no cost.", False),
    "budget": ("budget", "AI answers are paused: today's AI budget is reached. This answer comes from the Help Center at no cost.", False),
    "breaker": ("breaker", "AI answers are paused while the model provider is failing. This answer comes from the Help Center at no cost.", True),
    "quota": ("provider", "AI answers are unavailable: the model provider is not accepting requests right now. This answer comes from the Help Center at no cost.", True),
    "unavailable": ("provider", "AI answers are unavailable: the model provider is not accepting requests right now. This answer comes from the Help Center at no cost.", True),
}

MAX_CITATIONS = 3
MAX_LINKS = 4
SECONDARY_RATIO = 0.8


@dataclass(frozen=True)
class AppHelpAnswer:
    """A complete $0 product-help answer. :meth:`to_response` builds the
    ``ChatResponse`` (zero usage); the engine adds its turn ids and stream mode."""

    answer: str
    citations: list[Citation] = field(default_factory=list)
    console_links: list[ConsoleLink] = field(default_factory=list)
    blocks: list[dict[str, Any]] = field(default_factory=list)
    notice: TurnNotice | None = None
    follow_ups: list[str] = field(default_factory=list)

    def to_response(self, **updates: Any) -> ChatResponse:
        data: dict[str, Any] = {
            "answer": self.answer,
            "citations": [c.model_dump(mode="json") for c in self.citations],
            "console_links": [c.model_dump(mode="json") for c in self.console_links],
            "blocks": self.blocks,
            "answer_kind": "product_help",
            "notice": self.notice.model_dump(mode="json") if self.notice else None,
            "follow_ups": list(self.follow_ups),
            "usage": TurnUsage().model_dump(mode="json"),
            "cost": 0.0,
        }
        data.update(updates)
        return ChatResponse.model_validate(data)


# --------------------------------------------------------------------------- #
# Routing and retrieval.
# --------------------------------------------------------------------------- #
def search_docs(query: str, k: int = 4, *, knowledge: AppKnowledge | None = None) -> list[tuple[DocChunk, float]]:
    """The top Help Center sections for ``query`` (best first; ``[]`` = not covered)."""
    knowledge = knowledge or get_app_knowledge()
    return [(knowledge.chunks_by_id[hit.key], hit.score) for hit in knowledge.index.search(query, k)]


def search_targets(
    query: str, k: int = 2, *, floor: float = 9.0, relative: float = 0.75,
    knowledge: AppKnowledge | None = None,
) -> list[ConsoleTarget]:
    """Console destinations whose labels, keywords or owned settings keys match: none
    when the best is below ``floor``, else the hits scoring at least ``relative`` of the
    best (a lone strong match does not drag weak neighbours along)."""
    knowledge = knowledge or get_app_knowledge()
    hits = knowledge.target_index.search(query, k, floor=floor)
    if not hits:
        return []
    return [knowledge.targets[h.key] for h in hits if h.score >= relative * hits[0].score]


def classify_intent(message: str) -> IntentClass:
    """How ``message`` reads before any retrieval. ``"data"`` when it names a specific
    object, a time window or a data request, or a filtered set without a strong cue;
    ``"settings_key"`` when it names a Preferences key; otherwise the strongest cue
    class present (``"strong"``, ``"product"``, ``"weak"``) or ``"none"``."""
    text = message if isinstance(message, str) else ""
    if _ENTITY_RE.search(text):
        return "data"
    if _settings_keys(text):
        return "settings_key"
    if _DATA_SIGNAL_RE.search(text):
        return "data"
    if _STRONG_CUE_RE.search(text):
        return "strong"
    if _SOFT_DATA_RE.search(text):
        return "data"
    if _PRODUCT_CUE_RE.search(text):
        return "product"
    if _WEAK_CUE_RE.search(text):
        return "weak"
    return "none"


def routes_to_app_help(message: str, *, knowledge: AppKnowledge | None = None) -> bool:
    """True when ``message`` is a product question the Help Center covers: it names a
    settings key, or it carries a product cue, no data signal (see
    :func:`classify_intent`) and a BM25F match above that cue class's floor (plus, for
    product and weak cues, no word the corpus never uses). ``False`` whenever the
    corpus is unavailable."""
    if not isinstance(message, str) or not message.strip():
        return False
    try:
        knowledge = knowledge or get_app_knowledge()
    except Exception:  # noqa: BLE001
        return False
    intent = classify_intent(message)
    if intent == "settings_key":
        return True
    floor = ROUTE_FLOORS.get(intent)
    if floor is None:
        return False
    if intent in ("product", "weak") and knowledge.index.unknown_terms(message):
        return False
    return knowledge.index.best_score(message) >= floor


# --------------------------------------------------------------------------- #
# Settings keys (code-derived defaults; values never read).
# --------------------------------------------------------------------------- #
@functools.lru_cache(maxsize=1)
def _settings_index() -> dict[str, dict[str, Any]]:
    """Dotted settings key → its schema field (defaults only; computed once)."""
    from ..api.settings_schema import settings_schema  # lazy: pure, imports config only

    out: dict[str, dict[str, Any]] = {}
    for section in settings_schema().get("sections", []):
        key = section.get("key")
        for item in section.get("fields", []):
            name = item.get("name")
            if not isinstance(name, str):
                continue
            dotted = name if key == "general" else f"{key}.{name}"
            out[dotted] = {**item, "top": name if key == "general" else key}
        if key != "general" and isinstance(key, str):
            out.setdefault(key, {"name": key, "type": "object", "default": None, "top": key, "section": True})
            out[f"__fields__:{key}"] = {"fields": [f for f in section.get("fields", []) if isinstance(f, dict)]}
    return out


def _settings_keys(message: str) -> list[str]:
    candidates = [m.group(1) for m in _SETTING_KEY_RE.finditer(message or "")]
    if not candidates:
        return []
    index = _settings_index()
    return [c for c in dict.fromkeys(candidates) if c in index and not c.startswith("__")]


def _owner_target(top_key: str, knowledge: AppKnowledge) -> ConsoleTarget | None:
    owners = [t for t in knowledge.targets.values() if t.kind == "settings" and top_key in t.owned_keys]
    return owners[0] if owners else knowledge.targets.get("settings:advanced_all")


def _describe_default(value: Any) -> str:
    if value is None:
        return "no default"
    if isinstance(value, bool):
        return "on" if value else "off"
    if isinstance(value, (int, float, str)):
        return f"`{value}`"
    return "a structured default"


def settings_key_answer(
    message: str, grants: Iterable[tuple[str, str]], *, knowledge: AppKnowledge | None = None,
) -> tuple[str, list[ConsoleLink]] | None:
    """Answer a question naming settings keys from ``settings_schema()`` defaults and
    the owning Settings section. ``None`` when no known key is named."""
    keys = _settings_keys(message)
    if not keys:
        return None
    knowledge = knowledge or get_app_knowledge()
    index = _settings_index()
    held = frozenset(grants)
    lines: list[str] = []
    links: list[ConsoleLink] = []
    for key in keys[:3]:
        item = index[key]
        owner = _owner_target(str(item.get("top")), knowledge)
        if item.get("section"):
            sentence = f"`{key}` is a group of settings."
            fields = [f.get("name") for f in index.get(f"__fields__:{key}", {}).get("fields", [])]
            if fields:
                sentence = f"`{key}` is a group of settings ({', '.join(f'`{f}`' for f in fields[:6])})."
        else:
            kind = str(item.get("type") or "value")
            article = "an" if kind[:1] in "aeiou" else "a"
            sentence = f"`{key}` is {article} {kind} setting (default {_describe_default(item.get('default'))})."
            choices = item.get("choices")
            if isinstance(choices, list) and choices:
                sentence += " Choices: " + ", ".join(f"`{c}`" for c in choices[:8]) + "."
            description = item.get("description")
            if isinstance(description, str) and description.strip():
                sentence += f" {description.strip().rstrip('.')}."
        if owner is not None:
            sentence += f" Change it in {owner.breadcrumb}."
            link = console_link(owner, held)
            if link.id not in {l.id for l in links}:
                links.append(link)
        lines.append(sentence)
    return " ".join(lines), links


# --------------------------------------------------------------------------- #
# The extractive answer.
# --------------------------------------------------------------------------- #
def _procedure(text: str) -> tuple[str, list[str], str]:
    """``(intro, steps, outro)`` of a section: up to three sentences of prose before its
    first numbered list, the list's steps, and up to two sentences after it."""
    before, steps, after = split_procedure(text)
    if not steps:
        return first_sentences(text, 3), [], ""
    return first_sentences(before, 3), steps, first_sentences(after, 2)


def unavailable_notice(reason: str) -> TurnNotice:
    kind, message, retryable = _NOTICES.get(reason, _NOTICES["unavailable"])
    return TurnNotice(kind=kind, message=message, retryable=retryable)


def _guide_block(links: list[ConsoleLink], citations: list[Citation]) -> list[dict[str, Any]]:
    """The answer's guide block: where to go, never the steps. The numbered steps are
    already in the answer prose (rendered as Markdown, with their bold breadcrumbs);
    repeating them in a plain-text guide would show every step twice."""
    guide_links: list[dict[str, Any]] = []
    for link in links:
        if link.allowed:
            guide_links.append({"label": f"Open {link.label}", "ref": {"page": link.page, "opts": link.opts or None}})
    for citation in citations[:2]:
        if citation.doc:
            guide_links.append({"label": f"Read: {citation.title}", "ref": {"doc": citation.doc}})
    if not guide_links:
        return []
    raw = {
        "type": "guide", "id": "b1", "title": "From the Help Center", "provenance": "code",
        "artifact_kind": "guide", "allowed_views": ["guide"], "steps": [],
        "links": guide_links[:6],
    }
    blocks, _ = validate_blocks([raw])
    return blocks


def answer_app_question(
    message: str,
    *,
    grants: Iterable[tuple[str, str]] = (),
    reason: str = "not_configured",
    knowledge: AppKnowledge | None = None,
) -> AppHelpAnswer | None:
    """The deterministic $0 answer for a product question, or ``None`` when the message
    does not route to app help (the engine then reports the failure as usual) or the
    corpus is unavailable. ``grants`` is the caller's resolved ``(resource, action)``
    set; ``reason`` names why the model could not run (see :data:`UnavailableReason`)."""
    try:
        knowledge = knowledge or get_app_knowledge()
    except Exception:  # noqa: BLE001 - no corpus, no deterministic answer
        return None
    if not routes_to_app_help(message, knowledge=knowledge):
        return None
    held = frozenset(grants)
    notice = unavailable_notice(reason)
    settings_answer = settings_key_answer(message, held, knowledge=knowledge)
    hits = search_docs(message, 4, knowledge=knowledge)
    if settings_answer and hits and hits[0][1] < SETTINGS_PROSE_FLOOR:
        # The key itself is answered from the schema; prose that only shares a word
        # with "rag.top_k" would be noise beside it.
        hits = []

    # Secondary sections are cited only when they score close to the best one; a
    # distant runner-up is usually a different topic that shares a word.
    top_score = hits[0][1] if hits else 0.0
    citations: list[Citation] = []
    for chunk, score in hits:
        if len(citations) >= MAX_CITATIONS or (citations and score < SECONDARY_RATIO * top_score):
            continue
        citation = doc_citation(chunk, f"D{len(citations) + 1}", knowledge)
        if citation is not None and citation.doc not in {c.doc for c in citations}:
            citations.append(citation)

    link_ids: list[str] = list(hits[0][0].console) if hits else []
    if hits:
        # A glossary section named by an "Ask about this" topic links that topic's page.
        page = knowledge.pages[hits[0][0].page]
        ref = f"{page.path}#{hits[0][0].anchor}"
        link_ids.extend(t.console for t in knowledge.topics.values() if t.console and ref in t.docs)
    if not link_ids:
        # Only when the cited prose names no destination: the label search is noisier
        # than a breadcrumb the docs wrote down ("active" also matches Active sessions).
        link_ids.extend(t.id for t in search_targets(message, knowledge=knowledge))
    links: list[ConsoleLink] = list(settings_answer[1]) if settings_answer else []
    for target_id in dict.fromkeys(link_ids):
        if len(links) >= MAX_LINKS:
            break
        target = knowledge.targets.get(target_id)
        if target is not None and target_id not in {l.id for l in links}:
            links.append(console_link(target, held))

    parts: list[str] = []
    if settings_answer:
        parts.append(settings_answer[0])
    if hits:
        top = hits[0][0]
        intro, steps, outro = _procedure(top.text)
        ref = f" [{citations[0].id}]" if citations and citations[0].doc == doc_href(top, knowledge) else ""
        lead = f"From the Help Center ({knowledge.docs_version}), {chunk_title(top, knowledge)}:"
        parts.append(f"{lead} {intro}{ref}" if intro else f"{lead}{ref}")
        if steps:
            parts.append("\n".join(f"{n}. {step}" for n, step in enumerate(steps, start=1)))
            if outro and not intro:
                parts.append(outro)
        more = citations[1:]
        if more:
            parts.append("See also: " + "; ".join(f"{c.title} [{c.id}]" for c in more) + ".")
    if not parts:
        return None
    open_links = [l for l in links if l.allowed]
    if open_links:
        parts.append("Open: " + "; ".join(l.label for l in open_links) + ".")
    blocked = [l for l in links if not l.allowed]
    if blocked:
        parts.append(
            "You need additional access for: "
            + "; ".join(f"{l.label} ({l.requires})" for l in blocked)
            + ". Ask an administrator."
        )
    blocks = _guide_block(links, citations)
    return AppHelpAnswer(
        answer="\n\n".join(parts),
        citations=citations,
        console_links=links,
        blocks=blocks,
        notice=notice,
    )


def topic_question(topic_id: str, *, knowledge: AppKnowledge | None = None) -> str | None:
    """The fixed question for an "Ask about this" topic id (``kpi:mtta``,
    ``settings:models``); ``None`` for an unknown id. Client text never reaches a prompt
    through this path: only the server's own template does."""
    try:
        knowledge = knowledge or get_app_knowledge()
    except Exception:  # noqa: BLE001
        return None
    topic = knowledge.topics.get(topic_id) if isinstance(topic_id, str) else None
    return topic.question if topic else None


__all__ = [
    "AppHelpAnswer",
    "IntentClass",
    "ROUTE_FLOORS",
    "UnavailableReason",
    "answer_app_question",
    "classify_intent",
    "routes_to_app_help",
    "search_docs",
    "search_targets",
    "settings_key_answer",
    "target_allowed",
    "topic_question",
    "unavailable_notice",
]
