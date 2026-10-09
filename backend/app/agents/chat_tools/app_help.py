"""``app_help``: search the bundled, version-matched Help Center (SPEC §5.3, §5.4).

The read-only answer to "how do I…", "where is…" and "what does this KPI mean?". It
searches the integrity-checked app-knowledge corpus (``app.knowledge``) with BM25F and
returns, for each matching section:

* a ``D*`` :class:`~app.models.Citation` whose ``doc`` href is built from the corpus and
  validated (``/docs/<major.minor>/<path>#<anchor>``), never written by the model; a
  section the wire pattern cannot link (the Help Center home, a dotted release page) is
  shown as reference only, with no id to cite;
* the console destinations the section's bold breadcrumbs name, as console-map ids
  (``ToolOutcome.console_links``), with ``allowed`` from the caller's grants;
* one ``guide`` artifact (numbered steps of the best section as plain text, plus
  open/read links).

The observation is NOT fenced: the engine renders it with
:func:`app.knowledge.render_app_docs` into the trusted "Product reference" message
(§4.4), because the corpus is first-party, reviewed and hash-verified. It is product
reference, never instructions; the renderer neutralises every marker again.

No grant is required: the same pages are served unauthenticated under ``/docs/``, so
returning them leaks nothing; RBAC applies to the console links (``allowed``). The tool
makes no model call, no network call and no write; its cost is $0.
"""

from __future__ import annotations

from typing import Any, ClassVar

from pydantic import Field

from ...knowledge import (
    AppKnowledgeUnavailable,
    chunk_title,
    console_link,
    doc_citation,
    doc_href,
    load_app_knowledge,
    search_docs,
    search_targets,
)
from ...knowledge.render import list_steps, plain_inline
from ..blocks import display_text
from .base import Artifact, ChatTool, ChatToolContext, ToolOutcome
from .common import ToolInput, parse_input

DEFAULT_TOP_K = 4
MAX_TOP_K = 6
MAX_CONSOLE_TARGETS = 6
RELATIVE_FLOOR = 0.7
HELP_CENTER_FALLBACK = "/docs/installed/"


class AppHelpInput(ToolInput):
    query: str = Field(default="", max_length=300)
    top_k: int = Field(default=DEFAULT_TOP_K, ge=1, le=MAX_TOP_K)
    # An "Ask about this" topic id (``kpi:mtta``). Engine/route use only: its fixed
    # question replaces ``query`` and its doc anchors are cited first. Without it, the
    # turn's ``ChatToolContext.topic`` pins the anchors and the model's query stays.
    topic: str | None = Field(default=None, max_length=120)


class AppHelpTool(ChatTool):
    name: ClassVar[str] = "app_help"
    label: ClassVar[str] = "Searched the Help Center"
    scope: ClassVar[str] = "docs"
    requires: ClassVar[tuple[tuple[str, str], ...]] = ()
    signature: ClassVar[str] = (
        "app_help(query: str, top_k?: 1-6) — search this release's Help Center: how the "
        "product works, where a setting or page is, what a KPI or term means; returns "
        "[D#] sections and console destinations"
    )
    data_source: ClassVar[str] = "Bundled Help Center (this release)"
    display_keys: ClassVar[tuple[str, ...]] = ("top_k",)

    async def run(self, ctx: ChatToolContext, **inp: Any) -> ToolOutcome:
        parsed, failure = parse_input(AppHelpInput, inp)
        if failure is not None:
            return failure
        try:
            knowledge = await load_app_knowledge()
        except AppKnowledgeUnavailable as exc:
            return ToolOutcome(
                ok=False,
                status="error",
                summary="The Help Center index is unavailable in this build",
                error="The Help Center index is unavailable in this build",
                observation={
                    "kind": "app_help", "available": False, "reason": exc.reason,
                    "help_center": HELP_CENTER_FALLBACK,
                },
                sources=["Help Center"],
            )

        topic = knowledge.topics.get(parsed.topic) if parsed.topic else None
        query = topic.question if topic else parsed.query
        if topic is None and isinstance(ctx.topic, str):
            # A turn started from "Ask about this" (``ChatRequest.topic``): its
            # glossary sections lead every Help Center search of the turn, while the
            # model's own query (if any) still ranks the rest.
            topic = knowledge.topics.get(ctx.topic)
            if topic is not None and not query.strip():
                query = topic.question
        if not query.strip():
            return ToolOutcome.failure("Invalid input: check query")

        hits = search_docs(query, parsed.top_k, knowledge=knowledge)
        if hits:
            # Drop the weak tail: a section far below the best usually shares a word,
            # not the topic, and every excerpt costs prompt tokens.
            hits = [(c, s) for c, s in hits if s >= RELATIVE_FLOOR * hits[0][1]]
        if topic is not None:
            # The topic's own glossary anchors lead, then the search results.
            pinned = [
                c for c in knowledge.chunks
                if f"{knowledge.pages[c.page].path}#{c.anchor}" in topic.docs
            ]
            seen = {c.id for c in pinned}
            hits = [(c, float("inf")) for c in pinned] + [(c, s) for c, s in hits if c.id not in seen]
            hits = hits[: parsed.top_k]

        held = frozenset(ctx.grants)
        results: list[dict[str, Any]] = []
        citations = []
        console_ids: list[str] = []
        for chunk, _score in hits:
            # Only a section with a valid Help Center link gets a ``D*`` id: an id the
            # model can cite must resolve to a Citation (the Help Center home and the
            # dotted release pages cannot be expressed by the wire pattern), and a
            # later call's renumbering only renames ids that have one.
            ref: str | None = f"D{len(citations) + 1}"
            citation = doc_citation(chunk, ref, knowledge)
            if citation is not None:
                citations.append(citation)
            else:
                ref = None
            page = knowledge.pages[chunk.page]
            results.append({
                "ref": ref,
                "title": chunk_title(chunk, knowledge),
                "breadcrumb": " › ".join(page.nav),
                "href": doc_href(chunk, knowledge),
                "text": chunk.text,
                "console": list(chunk.console),
            })
            console_ids.extend(chunk.console)
        if topic is not None and topic.console:
            console_ids.insert(0, topic.console)
        if not console_ids:
            console_ids.extend(t.id for t in search_targets(query, knowledge=knowledge))
        targets = [knowledge.targets[i] for i in dict.fromkeys(console_ids) if i in knowledge.targets]
        targets = targets[:MAX_CONSOLE_TARGETS]
        links = [console_link(t, held) for t in targets]
        observation = {
            "kind": "app_help",
            "available": True,
            "docs_version": knowledge.docs_version,
            "results": results,
            "console_targets": [
                {"id": l.id, "label": l.label, "requires": l.requires, "allowed": l.allowed}
                for l in links
            ],
        }
        if not results:
            return ToolOutcome(
                ok=True,
                summary=f"No Help Center {knowledge.docs_version} section matched",
                untrusted_params={"query": display_text(query, 200)},
                observation={**observation, "abstained": True},
                rows=0,
                sources=[f"Help Center {knowledge.docs_version}"],
                console_links=[t.id for t in targets],
            )

        artifacts = []
        guide = _guide_artifact(hits[0][0], links, citations)
        if guide is not None:
            artifacts.append(guide)
        count = len(results)
        return ToolOutcome(
            ok=True,
            summary=(
                f"{count} Help Center {knowledge.docs_version} section{'s' if count != 1 else ''}"
                + (f", {len(links)} console destination{'s' if len(links) != 1 else ''}" if links else "")
            ),
            untrusted_params={"query": display_text(query, 200)},
            observation=observation,
            artifacts=artifacts,
            rows=count,
            sources=[f"Help Center {knowledge.docs_version}"],
            citations=citations,
            console_links=[t.id for t in targets],
        )


def _guide_artifact(chunk: Any, links: list[Any], citations: list[Any]) -> Artifact | None:
    """Steps of the best section plus links: allowed console destinations first (the
    meta row lists disallowed ones as plain text with the grant they need), then the
    cited Help Center sections."""
    guide_links: list[dict[str, Any]] = []
    for link in links:
        if link.allowed:
            ref: dict[str, Any] = {"page": link.page}
            if link.opts:
                ref["opts"] = dict(link.opts)
            guide_links.append({"label": f"Open {link.label}", "ref": ref})
    # A Help Center link's label is the section title alone: the client adds the
    # presentation prefix ("Read: …") to doc links, so a server prefix would double it.
    # Two sections of one page can share a title (and a link): each is listed once.
    read = {link["label"] for link in guide_links}
    for citation in citations[:3]:
        if citation.doc and citation.title not in read and all(
                link["ref"].get("doc") != citation.doc for link in guide_links):
            read.add(citation.title)
            guide_links.append({"label": citation.title, "ref": {"doc": citation.doc}})
    # The guide renders steps as plain text, so their Markdown is flattened here (a
    # literal ``**Settings → …**`` or a step clipped mid-token reads as broken).
    steps = [{"text": text} for step in list_steps(chunk.text) if (text := plain_inline(step))]
    if not guide_links and not steps:
        return None
    return Artifact(
        id="a1",
        kind="guide",
        title="Help Center guide",
        title_trusted=True,
        data={"steps": steps[:10], "links": guide_links[:6]},
        provenance="code",
    )
