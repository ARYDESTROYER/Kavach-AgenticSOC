"""App knowledge: the version-matched Help Center corpus chat answers product
questions from (chat revamp SPEC §5.4, §5.4.1).

* :mod:`.corpus` — the integrity-checked, fail-closed loader for the bundled JSON
  (``app_docs.json``, ``aliases.json``, ``console_map.json``, ``manifest.json``).
* :mod:`.index` — the dependency-free BM25F retrieval.
* :mod:`.render` — ``D*`` citations, console links (``allowed`` from a pre-resolved
  grant set) and the trusted ``<<<APP_DOCS>>>`` product-reference message.
* :mod:`.answer` — the deterministic $0 extractive answer used when no model can run.

Trust: the corpus is first-party, reviewed, version-locked and hash-verified at load,
so it is TRUSTED product reference behind its OWN boundary. It is not a RAG source and
``tools.rag.TRUSTED_KNOWLEDGE_SOURCES`` is unchanged; :data:`RESERVED_SOURCE_LABELS` are
the labels an operator import must never be able to claim.

Importing this package is light: it defines :data:`RESERVED_SOURCE_LABELS` and loads
nothing else. The public names below resolve lazily (PEP 562), so ``tools.rag`` can
import the reserved labels without pulling in the blocks/models stack, and no import
cycle can form through this package. Nothing is read from disk until first use.
"""

from __future__ import annotations

import importlib
from typing import TYPE_CHECKING, Any

# Source labels that name this corpus. ``tools.rag._sanitise_source_label`` must store
# an operator import that claims one of them as ``"imported"`` (anti-minting, §5.4).
RESERVED_SOURCE_LABELS: frozenset[str] = frozenset({"app_docs", "app_help", "product_docs"})

# Public name -> the submodule that defines it.
_EXPORTS: dict[str, str] = {
    **{name: "corpus" for name in (
        "AppKnowledge", "AppKnowledgeUnavailable", "ConsoleTarget", "DocChunk", "DocPage",
        "Topic", "app_knowledge_status", "docs_line_for", "get_app_knowledge",
        "load_app_knowledge", "warm_app_knowledge",
    )},
    **{name: "answer" for name in (
        "AppHelpAnswer", "answer_app_question", "classify_intent", "routes_to_app_help",
        "search_docs", "search_targets", "settings_key_answer", "topic_question",
        "unavailable_notice",
    )},
    **{name: "render" for name in (
        "chunk_title", "console_grant_pairs", "console_link", "doc_citation", "doc_href",
        "observation_refs", "plain_inline", "rebase_doc_citations", "render_app_docs",
        "resolve_console_links",
    )},
}

if TYPE_CHECKING:  # static analysis sees the names; runtime resolves them lazily
    from .answer import (
        AppHelpAnswer,
        answer_app_question,
        classify_intent,
        routes_to_app_help,
        search_docs,
        search_targets,
        settings_key_answer,
        topic_question,
        unavailable_notice,
    )
    from .corpus import (
        AppKnowledge,
        AppKnowledgeUnavailable,
        ConsoleTarget,
        DocChunk,
        DocPage,
        Topic,
        app_knowledge_status,
        docs_line_for,
        get_app_knowledge,
        load_app_knowledge,
        warm_app_knowledge,
    )
    from .render import (
        chunk_title,
        console_grant_pairs,
        console_link,
        doc_citation,
        doc_href,
        observation_refs,
        plain_inline,
        rebase_doc_citations,
        render_app_docs,
        resolve_console_links,
    )


def __getattr__(name: str) -> Any:
    module_name = _EXPORTS.get(name)
    if module_name is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    value = getattr(importlib.import_module(f".{module_name}", __name__), name)
    globals()[name] = value  # resolve once
    return value


def __dir__() -> list[str]:
    return sorted({*globals(), *_EXPORTS})


# Literal so static analysis checks it; a test pins it to ``_EXPORTS``.
__all__ = [
    "AppHelpAnswer",
    "AppKnowledge",
    "AppKnowledgeUnavailable",
    "ConsoleTarget",
    "DocChunk",
    "DocPage",
    "RESERVED_SOURCE_LABELS",
    "Topic",
    "answer_app_question",
    "app_knowledge_status",
    "chunk_title",
    "classify_intent",
    "console_grant_pairs",
    "console_link",
    "doc_citation",
    "doc_href",
    "docs_line_for",
    "get_app_knowledge",
    "load_app_knowledge",
    "observation_refs",
    "plain_inline",
    "rebase_doc_citations",
    "render_app_docs",
    "resolve_console_links",
    "routes_to_app_help",
    "search_docs",
    "search_targets",
    "settings_key_answer",
    "topic_question",
    "unavailable_notice",
    "warm_app_knowledge",
]
