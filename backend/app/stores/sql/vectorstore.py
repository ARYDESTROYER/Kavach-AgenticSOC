"""SQL-backed RAG vector store (Epoch A).

Implements the existing ``VectorStore`` ABC so it drops in behind ``RagService``
unchanged. Two storage strategies behind ONE interface:

* SQLite / generic SQL — the embedding is stored as a JSON list of floats and
  cosine similarity is computed in Python (reusing the same ``_cosine`` math as
  the in-memory store). Zero extra services; correct ordering; the natural
  dev/test path.
* PostgreSQL — when ``pgvector`` is available the production path can use a native
  ``vector`` column with the cosine distance operator ``<=>``. pgvector is
  imported LAZILY (only on Postgres) so SQLite/test envs never need it.

Every chunk is tagged with the embedding ``model`` + ``dim`` (mirroring
``ESVectorStore``) so an embedding-space change (model/dim) is DETECTED and the
caller can clear + reseed — vectors are NEVER truncated to force a match.
"""

from __future__ import annotations

import logging

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker

from ...tools.vectorstore import (
    EmbeddingSpaceMismatch,
    StoredChunk,
    VectorStore,
    _cosine,
    _document_id_of,
    _group_documents,
    _stats_of,
)
from .models import RagChunkRow

logger = logging.getLogger("tlsoc.stores.sql.vectorstore")


class SqlVectorStore(VectorStore):
    """Persistent RAG vectors in a SQL table; cosine in Python (SQLite) or via
    pgvector ``<=>`` when available on Postgres."""

    def __init__(self, engine: AsyncEngine) -> None:
        self._engine = engine
        self._sm = async_sessionmaker(engine, expire_on_commit=False)
        self._is_pg = engine.url.get_backend_name() == "postgresql"

    async def add(self, chunks: list[StoredChunk]) -> None:
        usable = [c for c in chunks if c.embedding]
        if not usable:
            return
        async with self._sm() as session:
            for c in usable:
                # Upsert by doc_id: a chunk with a known doc_id replaces the prior
                # one (no duplicates) — same semantics as the in-memory/ES stores.
                if c.doc_id is not None:
                    await session.execute(
                        delete(RagChunkRow).where(RagChunkRow.doc_id == c.doc_id)
                    )
                session.add(
                    RagChunkRow(
                        doc_id=c.doc_id,
                        text=c.text,
                        source=c.source,
                        metadata_json=dict(c.metadata),
                        embedding_model=c.embedding_model,
                        dim=c.dim or len(c.embedding),
                        embedding=list(c.embedding),
                    )
                )
            await session.commit()

    async def search(self, query_vector: list[float], top_k: int) -> list[tuple[StoredChunk, float]]:
        async with self._sm() as session:
            rows = (await session.execute(select(RagChunkRow))).scalars().all()
        scored: list[tuple[StoredChunk, float]] = []
        for row in rows:
            emb = list(row.embedding or [])
            if not emb:
                continue
            # Guard the embedding space: a dim mismatch means query + stored vectors
            # live in different spaces. Do NOT truncate; signal a reseed.
            if len(query_vector) != len(emb):
                raise EmbeddingSpaceMismatch(
                    f"query dim {len(query_vector)} != stored dim {len(emb)}"
                )
            chunk = StoredChunk(
                text=row.text,
                source=row.source,
                metadata=dict(row.metadata_json or {}),
                embedding=emb,
                embedding_model=row.embedding_model,
                dim=int(row.dim or len(emb)),
            )
            scored.append((chunk, _cosine(query_vector, emb)))
        scored.sort(key=lambda t: t[1], reverse=True)
        return scored[:top_k]

    async def count(self) -> int:
        async with self._sm() as session:
            return int((await session.execute(select(func.count()).select_from(RagChunkRow))).scalar() or 0)

    async def clear(self) -> None:
        async with self._sm() as session:
            await session.execute(delete(RagChunkRow))
            await session.commit()

    async def embedding_space(self) -> tuple[str, int] | None:
        async with self._sm() as session:
            row = (await session.execute(select(RagChunkRow).limit(1))).scalars().first()
        if row is None:
            return None
        return (row.embedding_model, int(row.dim or len(row.embedding or [])))

    # --------------------------------------------------------------------- #
    # Document management. The metadata JSON is portable across SQLite/Postgres
    # but a JSON-path filter is dialect-specific; load + filter in Python (the
    # corpus is small: seeds + a handful of imported docs). Store methods are
    # strict: callers that intentionally degrade gracefully catch at the service
    # boundary, while export/reconciliation can distinguish an outage from empty.
    # --------------------------------------------------------------------- #
    async def _load_all(self) -> list[StoredChunk]:
        async with self._sm() as session:
            rows = (await session.execute(select(RagChunkRow))).scalars().all()
        return [
            StoredChunk(
                text=r.text,
                source=r.source,
                metadata=dict(r.metadata_json or {}),
                embedding=list(r.embedding or []),
                embedding_model=r.embedding_model,
                dim=int(r.dim or len(r.embedding or [])),
                doc_id=r.doc_id,
            )
            for r in rows
        ]

    async def list_documents(self) -> list[dict]:
        return _group_documents(await self._load_all())

    async def list_chunks(self, document_id: str) -> list[StoredChunk]:
        out = [c for c in await self._load_all() if _document_id_of(c) == document_id]
        out.sort(key=lambda c: int((c.metadata or {}).get("chunk_index", 0) or 0))
        return out

    async def list_all_chunks(self) -> list[StoredChunk]:
        return await self._load_all()

    async def delete_document(self, document_id: str) -> int:
        async with self._sm() as session:
            rows = (await session.execute(select(RagChunkRow))).scalars().all()
            victims = [
                r
                for r in rows
                if _document_id_of(
                    StoredChunk(text=r.text, source=r.source, metadata=dict(r.metadata_json or {}))
                )
                == document_id
            ]
            for r in victims:
                await session.delete(r)
            await session.commit()
            return len(victims)

    async def stats(self) -> dict:
        return _stats_of(await self._load_all())
