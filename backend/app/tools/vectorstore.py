"""Vector store interface + an always-available in-memory cosine store, plus an
optional persistent Elasticsearch ``dense_vector`` store.

The in-memory store keeps RAG working with zero extra services (it degrades
gracefully — Gate 2). The ES store persists embeddings to ``tlsoc-agent-rag`` and
serves kNN through the MANAGEMENT credential (read/write under ``tlsoc-agent-*``);
it is selected only when a real management ES client is present so offline tests
(fake in-memory ES, no kNN) keep using the in-memory store.

Both stores tag every chunk with the embedding ``model`` + vector ``dim`` so a
mismatch (the embedding model or its dimensionality changed) can be detected and
the corpus CLEARED + reseeded — vectors are NEVER truncated to force a match,
which would silently corrupt similarity.
"""

from __future__ import annotations

import logging
import math
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:  # pragma: no cover - typing only
    from ..es.base import BaseESClient

logger = logging.getLogger("tlsoc.tools.vectorstore")

# Persistent RAG index (owned under tlsoc-agent-*, management credential only).
RAG_INDEX = "tlsoc-agent-rag"


@dataclass
class StoredChunk:
    text: str
    source: str
    metadata: dict[str, Any] = field(default_factory=dict)
    embedding: list[float] = field(default_factory=list)
    # Embedding-space provenance: the model that produced ``embedding`` and its
    # dimensionality. Used to detect a model/dim change and trigger a reseed.
    embedding_model: str = ""
    dim: int = 0
    # Optional stable id for upsert semantics (C3-5 resolved-case memory): adding a
    # chunk with an existing doc_id REPLACES it instead of creating a duplicate.
    doc_id: str | None = None


class EmbeddingSpaceMismatch(RuntimeError):
    """Raised when stored chunks were embedded in a different space (model/dim)
    than the current query/embedding. The caller CLEARS + reseeds; it does NOT
    truncate vectors."""


class VectorStore(ABC):
    @abstractmethod
    async def add(self, chunks: list[StoredChunk]) -> None: ...

    @abstractmethod
    async def search(self, query_vector: list[float], top_k: int) -> list[tuple[StoredChunk, float]]: ...

    @abstractmethod
    async def count(self) -> int: ...

    async def clear(self) -> None:
        """Drop all stored chunks. Default no-op; concrete stores override."""
        return None

    async def embedding_space(self) -> tuple[str, int] | None:
        """Return the (model, dim) the store currently holds, or None if empty."""
        return None

    # --------------------------------------------------------------------- #
    # Document management (see + manage the RAG corpus). A "document" is the
    # set of chunks sharing ``metadata["document_id"]``. Seed/legacy chunks
    # with no ``document_id`` are grouped under a synthetic ``seed:<source>``
    # pseudo-document so they stay visible. Concrete persistence methods are strict;
    # user-facing services decide where an outage may degrade to an empty result,
    # while export and reconciliation paths can distinguish failure from emptiness.
    # --------------------------------------------------------------------- #
    @abstractmethod
    async def list_documents(self) -> list[dict[str, Any]]:
        """Group stored chunks by document → one dict per document:
        ``{document_id, title, source, chunk_count, embedding_model, dim, added_at}``."""

    @abstractmethod
    async def list_chunks(self, document_id: str) -> list[StoredChunk]:
        """All stored chunks belonging to ``document_id`` (chunk_index order)."""

    @abstractmethod
    async def list_all_chunks(self) -> list[StoredChunk]:
        """EVERY stored chunk, in ONE pass.

        All three backends already materialise the whole corpus internally to answer
        ``list_documents``/``list_chunks``, so a caller that needs corpus-wide metadata
        must not fan out ``list_chunks`` per document: that turns one read into a full
        scan PER DOCUMENT (O(documents x corpus)) on a corpus with thousands of
        precedent documents. Strict, like its siblings: an outage raises rather than
        degrading to an empty corpus.
        """

    @abstractmethod
    async def delete_document(self, document_id: str) -> int:
        """Remove every chunk of ``document_id``; return the number removed."""

    @abstractmethod
    async def stats(self) -> dict[str, Any]:
        """Corpus stats: ``{total_chunks, by_source, embedding_model, dim}``."""


def _document_id_of(chunk: StoredChunk) -> str:
    """The grouping key for a chunk: its explicit ``metadata.document_id`` or a
    synthetic ``seed:<source>`` so legacy/seed chunks remain a visible document."""
    doc_id = (chunk.metadata or {}).get("document_id")
    if doc_id:
        return str(doc_id)
    return f"seed:{chunk.source or 'unknown'}"


def _group_documents(chunks: list[StoredChunk]) -> list[dict[str, Any]]:
    """Group ``chunks`` into the list_documents() shape. Stable, never raises."""
    groups: dict[str, dict[str, Any]] = {}
    order: list[str] = []
    for c in chunks:
        try:
            did = _document_id_of(c)
            meta = c.metadata or {}
            if did not in groups:
                order.append(did)
                groups[did] = {
                    "document_id": did,
                    "title": str(meta.get("title") or did),
                    "source": c.source or "unknown",
                    "chunk_count": 0,
                    "embedding_model": c.embedding_model or "",
                    "dim": int(c.dim or len(c.embedding) or 0),
                    "added_at": meta.get("added_at") or "",
                    "tags": list(meta.get("tags") or []),
                }
            g = groups[did]
            g["chunk_count"] += 1
            # Prefer a concrete title/added_at if a later chunk carries one.
            if meta.get("title") and g["title"] in (did, ""):
                g["title"] = str(meta["title"])
            if meta.get("added_at") and not g["added_at"]:
                g["added_at"] = meta["added_at"]
        except Exception:  # noqa: BLE001 — management must never raise
            continue
    return [groups[d] for d in order]


def _stats_of(chunks: list[StoredChunk]) -> dict[str, Any]:
    by_source: dict[str, int] = {}
    model = ""
    dim = 0
    for c in chunks:
        by_source[c.source or "unknown"] = by_source.get(c.source or "unknown", 0) + 1
        if not model and c.embedding_model:
            model = c.embedding_model
        if not dim:
            dim = int(c.dim or len(c.embedding) or 0)
    return {
        "total_chunks": len(chunks),
        "by_source": by_source,
        "embedding_model": model,
        "dim": dim,
    }


class InMemoryVectorStore(VectorStore):
    def __init__(self) -> None:
        self._chunks: list[StoredChunk] = []

    async def add(self, chunks: list[StoredChunk]) -> None:
        for c in chunks:
            if not c.embedding:
                continue
            # Upsert: a chunk with a known doc_id replaces the prior one (no dupes).
            if c.doc_id is not None:
                self._chunks = [x for x in self._chunks if x.doc_id != c.doc_id]
            self._chunks.append(c)

    async def search(self, query_vector: list[float], top_k: int) -> list[tuple[StoredChunk, float]]:
        scored: list[tuple[StoredChunk, float]] = []
        for c in self._chunks:
            # Guard the embedding space: a dim mismatch means the query and the
            # stored vectors live in different spaces. Do NOT silently truncate;
            # signal so the caller can clear + reseed.
            if len(query_vector) != len(c.embedding):
                raise EmbeddingSpaceMismatch(
                    f"query dim {len(query_vector)} != stored dim {len(c.embedding)}"
                )
            scored.append((c, _cosine(query_vector, c.embedding)))
        scored.sort(key=lambda t: t[1], reverse=True)
        return scored[:top_k]

    async def count(self) -> int:
        return len(self._chunks)

    async def clear(self) -> None:
        self._chunks = []

    async def embedding_space(self) -> tuple[str, int] | None:
        if not self._chunks:
            return None
        c = self._chunks[0]
        return (c.embedding_model, c.dim or len(c.embedding))

    async def list_documents(self) -> list[dict[str, Any]]:
        return _group_documents(list(self._chunks))

    async def list_chunks(self, document_id: str) -> list[StoredChunk]:
        out = [c for c in self._chunks if _document_id_of(c) == document_id]
        out.sort(key=lambda c: int((c.metadata or {}).get("chunk_index", 0) or 0))
        return out

    async def list_all_chunks(self) -> list[StoredChunk]:
        return list(self._chunks)

    async def delete_document(self, document_id: str) -> int:
        before = len(self._chunks)
        self._chunks = [c for c in self._chunks if _document_id_of(c) != document_id]
        return before - len(self._chunks)

    async def stats(self) -> dict[str, Any]:
        return _stats_of(list(self._chunks))


class ESVectorStore(VectorStore):
    """Persistent vector store over an Elasticsearch ``dense_vector`` index.

    Uses the MANAGEMENT ES client only (the index lives under ``tlsoc-agent-*``).
    The index is created lazily with the dimensionality of the first batch added,
    so it always matches the active embedding model. kNN search is issued through
    the management ``search`` path.
    """

    def __init__(self, es: "BaseESClient", index: str = RAG_INDEX) -> None:
        self._es = es
        self._index = index
        self._ensured_dim: int | None = None

    async def _ensure_index(self, dim: int) -> None:
        if self._ensured_dim == dim and await self._es.index_exists(self._index):
            return
        if not await self._es.index_exists(self._index):
            await self._es.create_index(
                self._index,
                {
                    "mappings": {
                        "properties": {
                            "text": {"type": "text"},
                            "source": {"type": "keyword"},
                            "metadata": {"type": "object", "enabled": False},
                            "embedding_model": {"type": "keyword"},
                            "dim": {"type": "integer"},
                            "embedding": {
                                "type": "dense_vector",
                                "dims": dim,
                                "index": True,
                                "similarity": "cosine",
                            },
                        }
                    }
                },
            )
            logger.info("Created RAG vector index %s (dims=%d)", self._index, dim)
        self._ensured_dim = dim

    async def add(self, chunks: list[StoredChunk]) -> None:
        usable = [c for c in chunks if c.embedding]
        if not usable:
            return
        await self._ensure_index(len(usable[0].embedding))
        for c in usable:
            await self._es.index_doc(
                self._index,
                {
                    "text": c.text,
                    "source": c.source,
                    "metadata": c.metadata,
                    "embedding_model": c.embedding_model,
                    "dim": c.dim or len(c.embedding),
                    "embedding": c.embedding,
                },
                doc_id=c.doc_id,
                refresh=True,
            )

    async def search(self, query_vector: list[float], top_k: int) -> list[tuple[StoredChunk, float]]:
        if not await self._es.index_exists(self._index):
            return []
        body = {
            "size": top_k,
            "knn": {
                "field": "embedding",
                "query_vector": query_vector,
                "k": top_k,
                "num_candidates": max(top_k * 10, 50),
            },
        }
        resp = await self._es.search(self._index, body)
        out: list[tuple[StoredChunk, float]] = []
        for hit in resp.get("hits", {}).get("hits", []):
            src = hit.get("_source", {}) or {}
            chunk = StoredChunk(
                text=str(src.get("text", "")),
                source=str(src.get("source", "unknown")),
                metadata=dict(src.get("metadata", {}) or {}),
                embedding=list(src.get("embedding", []) or []),
                embedding_model=str(src.get("embedding_model", "")),
                dim=int(src.get("dim", 0) or 0),
                doc_id=str(hit.get("_id", "")) or None,
            )
            # ES kNN cosine score is in [0, 1] (cosine remapped); pass it through.
            out.append((chunk, float(hit.get("_score") or 0.0)))
        return out

    async def count(self) -> int:
        if not await self._es.index_exists(self._index):
            return 0
        return await self._es.count(self._index, {"query": {"match_all": {}}})

    async def clear(self) -> None:
        """Reset the corpus by recreating the index. We do not delete documents
        one-by-one; for a model/dim change the mapping itself must change, so the
        index is dropped via the management client if available."""
        try:
            delete = getattr(self._es, "delete_index", None)
            if delete is not None:
                await delete(self._index)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Could not drop RAG index %s on clear: %s", self._index, exc)
        self._ensured_dim = None

    async def embedding_space(self) -> tuple[str, int] | None:
        if not await self._es.index_exists(self._index):
            return None
        resp = await self._es.search(self._index, {"size": 1, "query": {"match_all": {}}})
        hits = resp.get("hits", {}).get("hits", [])
        if not hits:
            return None
        src = hits[0].get("_source", {}) or {}
        dim = int(src.get("dim", 0) or len(src.get("embedding", []) or []))
        return (str(src.get("embedding_model", "")), dim)

    async def _scan_all(self, *, with_ids: bool = False) -> list[tuple[str, StoredChunk]]:
        """Return all stored chunks (and their ES ``_id``), or raise on outage.

        Presentation-oriented callers catch at the service boundary. Export and
        corpus reconciliation intentionally need a failed read to stay different
        from a confirmed empty corpus.
        """
        out: list[tuple[str, StoredChunk]] = []
        if not await self._es.index_exists(self._index):
            return out
        # The corpus is small (seeds + a handful of imported docs); a single
        # large match_all page is sufficient and avoids a scroll dependency.
        resp = await self._es.search(
            self._index, {"size": 10000, "query": {"match_all": {}}}
        )
        for hit in resp.get("hits", {}).get("hits", []):
            src = hit.get("_source", {}) or {}
            chunk = StoredChunk(
                text=str(src.get("text", "")),
                source=str(src.get("source", "unknown")),
                metadata=dict(src.get("metadata", {}) or {}),
                embedding=list(src.get("embedding", []) or []),
                embedding_model=str(src.get("embedding_model", "")),
                dim=int(src.get("dim", 0) or 0),
                doc_id=str(hit.get("_id", "")) or None,
            )
            out.append((str(hit.get("_id", "")), chunk))
        return out

    async def list_documents(self) -> list[dict[str, Any]]:
        return _group_documents([c for _id, c in await self._scan_all()])

    async def list_chunks(self, document_id: str) -> list[StoredChunk]:
        out = [c for _id, c in await self._scan_all() if _document_id_of(c) == document_id]
        out.sort(key=lambda c: int((c.metadata or {}).get("chunk_index", 0) or 0))
        return out

    async def list_all_chunks(self) -> list[StoredChunk]:
        return [c for _id, c in await self._scan_all()]

    async def delete_document(self, document_id: str) -> int:
        ids = [
            _id
            for _id, c in await self._scan_all()
            if _document_id_of(c) == document_id and _id
        ]
        if not ids:
            return 0
        delete_doc = getattr(self._es, "delete_doc", None)
        if delete_doc is None:
            logger.warning("ES client has no delete_doc; cannot delete RAG document")
            return 0
        removed = 0
        for _id in ids:
            try:
                await delete_doc(self._index, _id, refresh=True)
                removed += 1
            except Exception as exc:  # noqa: BLE001
                logger.warning("delete RAG chunk %s failed: %s", _id, exc)
        return removed

    async def stats(self) -> dict[str, Any]:
        return _stats_of([c for _id, c in await self._scan_all()])


def _cosine(a: list[float], b: list[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(a[i] * b[i] for i in range(len(a)))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(x * x for x in b))
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)
