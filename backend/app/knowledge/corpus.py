"""Integrity-checked loader for the bundled app-knowledge corpus (SPEC §5.4).

The four JSON files beside this module are produced by ``scripts/build_app_knowledge.py``
(``app_docs.json``, ``aliases.json``, ``manifest.json``) and by the webui console-map
contract test (``console_map.json``). They are TRUSTED product reference behind their
own boundary, which is only sound while nobody but the release can write them, so the
loader:

* reads from the package directory ONLY: no environment override, no working-directory
  lookup, no StateStore/KV/upload path, nothing an operator or a tenant can write;
* verifies every file's sha256 against ``manifest.json``, the manifest schema, and that
  the corpus's documentation line equals this build's ``major.minor`` (line endings are
  normalised to LF before hashing, so a ``core.autocrlf`` checkout still verifies: JSON
  strings cannot hold a raw newline, so a line ending never changes content);
* validates the structure and neutralises fence markers in every text field again at
  load (the build already scrubs them; this is defence in depth);
* FAILS CLOSED: any problem makes the whole corpus unavailable (with a reason code)
  rather than serving a partially trusted one.

The parsed corpus and its BM25F index are built once per process on first use (about
a third of a second of CPU): async callers use :func:`load_app_knowledge`, which builds it
off the event loop, and the application can warm it at startup the same way.
"""

from __future__ import annotations

import asyncio
import functools
import hashlib
import json
import logging
import re
from dataclasses import dataclass, field
from pathlib import Path
from types import MappingProxyType
from typing import Any, Mapping

from .index import BM25FIndex, IndexedDoc, build_index

logger = logging.getLogger(__name__)

SCHEMA = 1
CORPUS_FILES = ("app_docs.json", "aliases.json", "console_map.json")
MANIFEST_FILE = "manifest.json"
# The package directory. Module-level so a test can point the PRIVATE loader at a
# tampered copy; nothing at runtime ever changes it.
_PACKAGE_DIR = Path(__file__).resolve().parent

_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_TARGET_ID_RE = re.compile(r"^[a-z0-9_]{1,40}:[a-z0-9_.-]{1,80}$")
_GRANT_RE = re.compile(r"^[a-z_]{1,40}:[a-z_]{1,40}$")
_PAGE_RE = re.compile(r"^[a-z][a-z_]{0,39}$")
_DOC_PATH_RE = re.compile(r"^(?:[a-z0-9_.-]+/)*$")
_ANCHOR_RE = re.compile(r"^[a-z0-9_-]*$")
_VERSION_RE = re.compile(r"^(\d+)\.(\d+)\.\d+")


class AppKnowledgeUnavailable(RuntimeError):
    """The corpus failed an integrity, version or schema check (fail closed).

    ``reason`` is a stable code: ``app_docs_missing``, ``app_docs_integrity``,
    ``app_docs_version`` or ``app_docs_schema``."""

    def __init__(self, reason: str, detail: str = "") -> None:
        super().__init__(f"{reason}: {detail}" if detail else reason)
        self.reason = reason
        self.detail = detail


@dataclass(frozen=True)
class DocPage:
    page: str                    # "administration/models-spend.md"
    title: str
    description: str
    nav: tuple[str, ...]         # Help Center nav breadcrumb
    path: str                    # "administration/models-spend/" ("" for the home page)
    tier: str                    # "guide" | "operate"


@dataclass(frozen=True)
class DocChunk:
    id: str                      # "administration/models-spend#budget-gate:0"
    page: str
    anchor: str                  # "" = the page top
    heading: str                 # "" = the page introduction
    text: str
    console: tuple[str, ...]     # console target ids resolved from bold breadcrumbs


@dataclass(frozen=True)
class ConsoleTarget:
    id: str                      # "settings:admin_users"
    kind: str                    # "page" | "settings" | "settings_card"
    label: str
    crumb: tuple[str, ...]
    page: str
    opts: Mapping[str, str]
    requires: str | None         # "users:manage"
    blurb: str
    keywords: tuple[str, ...]
    owned_keys: tuple[str, ...]

    @property
    def breadcrumb(self) -> str:
        return " › ".join(self.crumb) or self.label

    @property
    def grant(self) -> tuple[str, str] | None:
        if not self.requires:
            return None
        resource, _, action = self.requires.partition(":")
        return resource, action


@dataclass(frozen=True)
class Topic:
    id: str                      # "kpi:mtta" | "settings:models"
    kind: str
    label: str
    question: str
    docs: tuple[str, ...]        # "analyst/kpi-glossary/#mtta"
    console: str | None


@dataclass(frozen=True)
class AppKnowledge:
    """The verified corpus plus its indexes. Immutable and process-global (it holds no
    tenant data, so Demo Mode shares it safely)."""

    product_version: str
    docs_version: str
    pages: Mapping[str, DocPage]
    chunks: tuple[DocChunk, ...]
    targets: Mapping[str, ConsoleTarget]
    topics: Mapping[str, Topic]
    aliases: Mapping[str, tuple[str, ...]]
    index: BM25FIndex = field(repr=False)
    target_index: BM25FIndex = field(repr=False)
    chunks_by_id: Mapping[str, DocChunk] = field(repr=False)

    def page_of(self, chunk: DocChunk) -> DocPage:
        return self.pages[chunk.page]


# --------------------------------------------------------------------------- #
# Loading.
# --------------------------------------------------------------------------- #
def docs_line_for(version: str) -> str:
    """``major.minor`` of a product SemVer (``"0.1.13"`` → ``"0.1"``)."""
    match = _VERSION_RE.match(version or "")
    if match is None:
        raise AppKnowledgeUnavailable("app_docs_version", f"not a version: {version!r}")
    return f"{match.group(1)}.{match.group(2)}"


def _product_version() -> str:
    from .. import __version__

    return __version__


def _neutralise(value: Any) -> str:
    # Imported lazily: agents.prompts imports the RAG service, which may itself consult
    # this package (anti-minting), so a module-level import could form a cycle.
    from ..agents.prompts import neutralise_markers

    return neutralise_markers(value if isinstance(value, str) else "")


def _str(value: Any, what: str, *, allow_empty: bool = True) -> str:
    if not isinstance(value, str) or (not allow_empty and not value):
        raise AppKnowledgeUnavailable("app_docs_schema", f"{what} must be a string")
    return value


def _str_list(value: Any, what: str) -> list[str]:
    if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
        raise AppKnowledgeUnavailable("app_docs_schema", f"{what} must be a list of strings")
    return list(value)


def _read_verified(directory: Path) -> dict[str, Any]:
    """Read the manifest and every corpus file, verify hashes and versions, and return
    the parsed JSON documents keyed by file name."""
    try:
        manifest_bytes = (directory / MANIFEST_FILE).read_bytes()
    except OSError as exc:
        raise AppKnowledgeUnavailable("app_docs_missing", MANIFEST_FILE) from exc
    try:
        manifest = json.loads(manifest_bytes)
    except ValueError as exc:
        raise AppKnowledgeUnavailable("app_docs_integrity", "manifest is not JSON") from exc
    if not isinstance(manifest, dict) or manifest.get("schema") != SCHEMA:
        raise AppKnowledgeUnavailable("app_docs_schema", "unknown manifest schema")
    hashes = manifest.get("sha256")
    if not isinstance(hashes, dict) or set(hashes) != set(CORPUS_FILES):
        raise AppKnowledgeUnavailable("app_docs_integrity", "manifest does not list the corpus files")

    expected_line = docs_line_for(_product_version())
    if manifest.get("docs_version") != expected_line:
        raise AppKnowledgeUnavailable(
            "app_docs_version",
            f"corpus documents {manifest.get('docs_version')!r}, this build is {expected_line!r}",
        )

    documents: dict[str, Any] = {"manifest": manifest}
    for name in CORPUS_FILES:
        digest = hashes.get(name)
        if not isinstance(digest, str) or not _SHA256_RE.match(digest):
            raise AppKnowledgeUnavailable("app_docs_integrity", f"bad digest for {name}")
        try:
            data = (directory / name).read_bytes().replace(b"\r\n", b"\n")
        except OSError as exc:
            raise AppKnowledgeUnavailable("app_docs_missing", name) from exc
        if hashlib.sha256(data).hexdigest() != digest:
            raise AppKnowledgeUnavailable("app_docs_integrity", f"{name} does not match the manifest")
        try:
            documents[name] = json.loads(data)
        except ValueError as exc:
            raise AppKnowledgeUnavailable("app_docs_integrity", f"{name} is not JSON") from exc
        if not isinstance(documents[name], dict) or documents[name].get("schema") != SCHEMA:
            raise AppKnowledgeUnavailable("app_docs_schema", f"unknown schema in {name}")
    if documents["app_docs.json"].get("docs_version") != expected_line:
        raise AppKnowledgeUnavailable("app_docs_version", "corpus docs_version disagrees with the manifest")
    return documents


def _parse_pages(raw: Any) -> dict[str, DocPage]:
    if not isinstance(raw, dict) or not raw:
        raise AppKnowledgeUnavailable("app_docs_schema", "pages must be a non-empty object")
    pages: dict[str, DocPage] = {}
    for page, item in raw.items():
        if not isinstance(item, dict):
            raise AppKnowledgeUnavailable("app_docs_schema", f"page {page!r}")
        path = _str(item.get("path"), "page path")
        tier = item.get("tier")
        if not _DOC_PATH_RE.match(path) or tier not in ("guide", "operate"):
            raise AppKnowledgeUnavailable("app_docs_schema", f"page {page!r} path or tier")
        pages[page] = DocPage(
            page=page,
            title=_neutralise(_str(item.get("title"), "page title", allow_empty=False)),
            description=_neutralise(_str(item.get("description"), "page description")),
            nav=tuple(_neutralise(n) for n in _str_list(item.get("nav"), "page nav")),
            path=path,
            tier=tier,
        )
    return pages


def _parse_chunks(raw: Any, pages: Mapping[str, DocPage]) -> tuple[DocChunk, ...]:
    if not isinstance(raw, list) or not raw:
        raise AppKnowledgeUnavailable("app_docs_schema", "chunks must be a non-empty list")
    seen: set[str] = set()
    chunks: list[DocChunk] = []
    for item in raw:
        if not isinstance(item, dict):
            raise AppKnowledgeUnavailable("app_docs_schema", "chunk must be an object")
        chunk_id = _str(item.get("id"), "chunk id", allow_empty=False)
        page = _str(item.get("page"), "chunk page")
        anchor = _str(item.get("anchor"), "chunk anchor")
        if chunk_id in seen or page not in pages or not _ANCHOR_RE.match(anchor):
            raise AppKnowledgeUnavailable("app_docs_schema", f"chunk {chunk_id!r}")
        seen.add(chunk_id)
        console = _str_list(item.get("console"), "chunk console")
        if not all(_TARGET_ID_RE.match(c) for c in console):
            raise AppKnowledgeUnavailable("app_docs_schema", f"chunk {chunk_id!r} console ids")
        chunks.append(DocChunk(
            id=chunk_id,
            page=page,
            anchor=anchor,
            heading=_neutralise(_str(item.get("heading"), "chunk heading")),
            text=_neutralise(_str(item.get("text"), "chunk text", allow_empty=False)),
            console=tuple(console),
        ))
    return tuple(chunks)


def _parse_targets(raw: Any) -> dict[str, ConsoleTarget]:
    if not isinstance(raw, list) or not raw:
        raise AppKnowledgeUnavailable("app_docs_schema", "console targets must be a non-empty list")
    targets: dict[str, ConsoleTarget] = {}
    for item in raw:
        if not isinstance(item, dict):
            raise AppKnowledgeUnavailable("app_docs_schema", "console target must be an object")
        target_id = _str(item.get("id"), "target id")
        page = _str(item.get("page"), "target page")
        requires = item.get("requires")
        opts = item.get("opts")
        if (
            not _TARGET_ID_RE.match(target_id) or target_id in targets or not _PAGE_RE.match(page)
            or (requires is not None and not (isinstance(requires, str) and _GRANT_RE.match(requires)))
            or not isinstance(opts, dict) or not all(isinstance(v, str) for v in opts.values())
        ):
            raise AppKnowledgeUnavailable("app_docs_schema", f"console target {target_id!r}")
        targets[target_id] = ConsoleTarget(
            id=target_id,
            kind=_str(item.get("kind"), "target kind"),
            label=_neutralise(_str(item.get("label"), "target label", allow_empty=False)),
            crumb=tuple(_neutralise(c) for c in _str_list(item.get("crumb"), "target crumb")),
            page=page,
            opts=MappingProxyType({str(k): v for k, v in opts.items()}),
            requires=requires,
            blurb=_neutralise(_str(item.get("blurb"), "target blurb")),
            keywords=tuple(_neutralise(k) for k in _str_list(item.get("keywords"), "target keywords")),
            owned_keys=tuple(_str_list(item.get("owned_keys"), "target owned keys")),
        )
    return targets


def _parse_topics(raw: Any, targets: Mapping[str, ConsoleTarget], known_refs: set[str]) -> dict[str, Topic]:
    if not isinstance(raw, list):
        raise AppKnowledgeUnavailable("app_docs_schema", "topics must be a list")
    topics: dict[str, Topic] = {}
    for item in raw:
        if not isinstance(item, dict):
            raise AppKnowledgeUnavailable("app_docs_schema", "topic must be an object")
        topic_id = _str(item.get("id"), "topic id")
        console = item.get("console")
        docs = _str_list(item.get("docs"), "topic docs")
        if (
            not _TARGET_ID_RE.match(topic_id) or topic_id in topics
            or (console is not None and console not in targets)
            or any(ref not in known_refs for ref in docs)
        ):
            raise AppKnowledgeUnavailable("app_docs_schema", f"topic {topic_id!r}")
        topics[topic_id] = Topic(
            id=topic_id,
            kind=_str(item.get("kind"), "topic kind"),
            label=_neutralise(_str(item.get("label"), "topic label", allow_empty=False)),
            question=_neutralise(_str(item.get("question"), "topic question", allow_empty=False)),
            docs=tuple(docs),
            console=console,
        )
    return topics


def _parse_aliases(raw: Any) -> dict[str, tuple[str, ...]]:
    if not isinstance(raw, dict):
        raise AppKnowledgeUnavailable("app_docs_schema", "aliases must be an object")
    return {str(k): tuple(_str_list(v, f"alias {k!r}")) for k, v in raw.items()}


def _load(directory: Path) -> AppKnowledge:
    """Load and verify the corpus in ``directory`` (the package directory at runtime)."""
    documents = _read_verified(directory)
    corpus = documents["app_docs.json"]
    pages = _parse_pages(corpus.get("pages"))
    chunks = _parse_chunks(corpus.get("chunks"), pages)
    console_map = documents["console_map.json"]
    targets = _parse_targets(console_map.get("targets"))
    for chunk in chunks:
        if any(target not in targets for target in chunk.console):
            raise AppKnowledgeUnavailable("app_docs_schema", f"chunk {chunk.id!r} names an unknown console target")
    known_refs = {f"{pages[c.page].path}#{c.anchor}" for c in chunks if c.anchor}
    topics = _parse_topics(console_map.get("topics"), targets, known_refs)
    aliases = _parse_aliases(documents["aliases.json"].get("aliases"))

    index = build_index(
        (
            IndexedDoc(
                key=chunk.id, group=chunk.page, tier=pages[chunk.page].tier,
                heading=chunk.heading, title=pages[chunk.page].title,
                nav=" ".join(pages[chunk.page].nav), description=pages[chunk.page].description,
                text=chunk.text,
            )
            for chunk in chunks
        ),
        aliases,
    )
    target_index = build_index(
        (
            IndexedDoc(
                key=target.id, group=target.id, tier="guide",
                heading=f"{target.label} {target.label}", title=" ".join(target.crumb),
                nav=" ".join(target.keywords), description=target.blurb,
                text=" ".join(key.replace("_", " ") for key in target.owned_keys),
            )
            for target in targets.values()
        ),
        aliases,
    )
    return AppKnowledge(
        product_version=_str(corpus.get("product_version"), "product version"),
        docs_version=corpus["docs_version"],
        pages=MappingProxyType(pages),
        chunks=chunks,
        targets=MappingProxyType(targets),
        topics=MappingProxyType(topics),
        aliases=MappingProxyType(aliases),
        index=index,
        target_index=target_index,
        chunks_by_id=MappingProxyType({c.id: c for c in chunks}),
    )


@functools.lru_cache(maxsize=1)
def _load_cached() -> AppKnowledge | tuple[str, str]:
    """The corpus, or ``(reason, detail)`` when it failed to load (cached either way;
    a fresh exception is raised per call so tracebacks never accumulate)."""
    try:
        return _load(_PACKAGE_DIR)
    except AppKnowledgeUnavailable as exc:
        logger.error("app knowledge corpus unavailable (%s); product help is disabled", exc)
        return exc.reason, exc.detail
    except Exception as exc:  # noqa: BLE001 - any parse surprise is still fail-closed
        logger.exception("app knowledge corpus failed to load; product help is disabled")
        return "app_docs_integrity", type(exc).__name__


def get_app_knowledge() -> AppKnowledge:
    """The verified corpus. Raises :class:`AppKnowledgeUnavailable` (with ``reason``)
    when it failed any check; the outcome is cached for the process."""
    loaded = _load_cached()
    if isinstance(loaded, tuple):
        raise AppKnowledgeUnavailable(*loaded)
    return loaded


async def load_app_knowledge() -> AppKnowledge:
    """:func:`get_app_knowledge` for async code: the first, CPU-bound build runs in a
    worker thread so it never stalls the event loop; later calls return the cached
    corpus directly. Raises :class:`AppKnowledgeUnavailable` like the sync form."""
    if _load_cached.cache_info().currsize == 0:
        await asyncio.to_thread(_load_cached)
    return get_app_knowledge()


async def warm_app_knowledge() -> bool:
    """Build the corpus off the event loop (an application startup hook). Returns
    whether it is available; never raises."""
    try:
        await load_app_knowledge()
    except AppKnowledgeUnavailable:
        return False
    return True


def app_knowledge_status() -> tuple[bool, str | None]:
    """``(available, reason)`` without raising."""
    loaded = _load_cached()
    if isinstance(loaded, tuple):
        return False, loaded[0]
    return True, None
