"""SQL-backed RAG vector store (Epoch A; search paths Round 16, WP06).

Implements the existing ``VectorStore`` ABC so it drops in behind ``RagService``
unchanged. The embedding is always stored as a JSON list of floats (portable; no new
column, index or migration, #12). Search ranks by cosine similarity on one of three
paths:

* **An in-process matrix** (the usual path, on SQLite and PostgreSQL alike). A
  normalised float32 matrix of every stored embedding ranks the rows. It is rebuilt
  when this store writes (``add``, ``delete_document``, ``clear``), when ``count(*)`` or
  ``max(id)`` moves (another process added or removed rows), and at the latest after
  :data:`MATRIX_CACHE_TTL_SECONDS`: SQLite reuses the highest rowid after a delete
  (``RagChunkRow.id`` has no ``AUTOINCREMENT``), so a foreign upsert that replaces the
  newest row leaves both numbers unchanged. The matrix is built in a worker thread.
* **PostgreSQL with pgvector.** When the ``vector`` extension is installed (probed once
  per engine at start, :func:`engine.probe_pgvector`), the database ranks with ``<=>``
  over the JSON column cast to ``vector``, filtered to the query's dimension, and only
  the top rows are read back. Casting every stored JSON embedding on every query is
  slow (measured: 1.1 to 1.4 s at 2,000 chunks of 1,536 dimensions on PostgreSQL 16,
  against 30 to 55 ms for the matrix), so this path ranks only a corpus too large for
  the matrix (more than :data:`MATRIX_MAX_VALUES` stored numbers, so memory stays
  bounded) or a process without numpy. A real ``vector`` column with an index would
  make it the fast path, and needs a schema migration (a later round).
* **Pure Python.** Without numpy and without pgvector, every row is read and scored in
  Python, as before. numpy arrives through ``pgvector``, a pinned requirement of both
  images.

Whichever path ranks, the rows returned are read back and scored with the exact float64
:func:`~app.tools.vectorstore._cosine`, ordered by that score and then by row id, so the
three paths return the same chunks with the same scores. The ranking paths score in
float32, so they read back a few rows more than ``top_k`` and also every row whose
float32 score lies within the rounding band of the ``top_k`` cut (``_rank_tolerance``):
a near tie at the cut can then never hide a row whose exact score is higher.

Every chunk is tagged with the embedding ``model`` + ``dim`` (mirroring
``ESVectorStore``) so an embedding-space change (model/dim) is DETECTED and the caller
can clear + reseed: a stored embedding of another length raises
:class:`EmbeddingSpaceMismatch` on every path, and vectors are NEVER truncated to force a
match.
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import operator
import time
from dataclasses import dataclass
from typing import Any

from sqlalchemy import delete, func, select, text
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

#: The in-process matrix is rebuilt at least this often (seconds), whatever its
#: fingerprint says (see the module notes on SQLite rowid reuse).
MATRIX_CACHE_TTL_SECONDS = 60.0
#: How many rows beyond ``top_k`` a ranking path reads back before the exact rescoring.
RERANK_MARGIN = 8
# The unit roundoff of float32, the precision both ranking paths score in.
_FLOAT32_UNIT = 2.0 ** -24
# A matrix holding more stored numbers than this (about 2,600 chunks of 1,536
# dimensions, a few milliseconds of work) is ranked in a worker thread.
_RANK_OFFLOAD_VALUES = 4_000_000
#: The most stored numbers the in-process matrix holds (4 bytes each, about 100 MB:
#: some 16,000 chunks of 1,536 dimensions; a rebuild also holds the rows as read until
#: it ends). On PostgreSQL with pgvector a larger corpus is ranked in the database
#: instead.
MATRIX_MAX_VALUES = 25_000_000
# Rows read back per query when rescoring (well under every driver's bind limit).
_RESCORE_BATCH = 500

# pgvector ranks a zero-norm vector's cosine distance as NaN; ``_cosine`` scores it 0
# (distance 1), so the database query treats it the same way. The query returns the
# first ``:m`` rows by distance and every further row whose distance is within ``:tol``
# of the ``:k``-th (pgvector scores in float, so a near tie at the cut can hide a row
# whose exact score is higher; see ``_rank_tolerance``). ``ranked`` is referenced
# twice, so PostgreSQL computes each row's distance once.
_PGVECTOR_RANK_SQL = (
    "WITH ranked AS ("
    " SELECT id, CASE WHEN d = CAST('NaN' AS float8) THEN 1.0 ELSE d END AS distance"
    " FROM ("
    "  SELECT id, CAST(CAST(embedding AS TEXT) AS vector)"
    "  <=> CAST(CAST(:q AS TEXT) AS vector) AS d"
    "  FROM rag_chunks WHERE dim = :dim"
    " ) raw"
    "), numbered AS ("
    " SELECT id, distance, ROW_NUMBER() OVER (ORDER BY distance, id) AS rn FROM ranked"
    ") "
    "SELECT id FROM numbered "
    "WHERE rn <= :m"
    " OR distance <= (SELECT distance FROM numbered WHERE rn = :k) + :tol "
    "ORDER BY rn"
)


def _numpy() -> Any:
    """numpy, or None when it cannot be imported (then search scores in Python)."""
    try:
        import numpy
    except Exception:  # noqa: BLE001 (any import failure means the Python path)
        return None
    return numpy


def _clock() -> float:
    """The monotonic clock the matrix cache ages by (a seam for tests)."""
    return time.monotonic()


def _norm_of(vector: list[float]) -> float:
    """``sqrt(sum(x * x))`` summed in order, exactly as ``_cosine`` sums it."""
    return math.sqrt(sum(map(operator.mul, vector, vector)))


def _rank_tolerance(dim: int) -> float:
    """How far apart a float32 ranking score and the exact float64 cosine of the same row
    can be, doubled (two rows compared), for ``dim``-dimensional embeddings.

    Both ranking paths score in float32: the in-process matrix multiplies unit vectors
    rounded to float32, and pgvector stores float4 and sums its dot product and both
    norms in float. A float sum of ``dim`` products is off by at most about ``dim``
    units in the last place of the sum of their magnitudes, which is at most 1 for a
    cosine (Cauchy-Schwarz); the norms add as much again, and rounding each element to
    float32 adds a few units more. So every row whose exact score could still reach the
    ``top_k`` cut has a ranking score within this distance of the cut, and reading all
    of them back keeps the exact rescoring identical to the Python path."""
    return 2.0 * (2.0 * max(1, int(dim)) + 16.0) * _FLOAT32_UNIT


def _exact_cosine(query: list[float], query_norm: float, emb: list[float]) -> float:
    """``_cosine(query, emb)`` to the last bit (the same products, summed in the same
    order by the same ``sum``), with the query's norm computed once per search."""
    if not query or not emb or len(query) != len(emb):
        return 0.0
    dot = sum(map(operator.mul, query, emb))
    emb_norm = _norm_of(emb)
    if query_norm == 0 or emb_norm == 0:
        return 0.0
    return dot / (query_norm * emb_norm)


@dataclass
class _MatrixCache:
    """Every stored embedding as one normalised float32 matrix, in row id order.

    ``dims`` holds every stored embedding length; with more than one, ``matrix`` is
    empty and every query is a dimension mismatch."""

    fingerprint: tuple[int, int]
    generation: int
    loaded_at: float
    ids: Any
    matrix: Any
    dims: frozenset[int]


def _build_matrix(np: Any, rows: list[tuple[int, Any]]) -> tuple[Any, Any, frozenset[int]]:
    """``(ids, matrix, dims)`` from ``(id, stored embedding)`` rows. Pure; runs in a
    worker thread. The stored embeddings are decoded one row at a time into float32
    rows, so while it runs the memory held is the rows as read (their stored text, or
    the lists a driver decoded) plus the float32 matrix. Raises ``ValueError`` or
    ``TypeError`` for an embedding that is not a list of numbers."""
    ids: list[int] = []
    vectors: list[Any] = []
    dims: set[int] = set()
    for row_id, raw in rows:
        emb = json.loads(raw) if isinstance(raw, (str, bytes, bytearray)) else raw
        if not emb:
            continue
        if not isinstance(emb, list):
            raise TypeError("a stored embedding is not a list")
        dims.add(len(emb))
        if len(dims) > 1:
            continue
        vec = np.asarray(emb, dtype=np.float64)
        norm = float(np.linalg.norm(vec))
        if norm > 0 and math.isfinite(norm):
            vec = vec / norm
        vectors.append(vec.astype(np.float32))
        ids.append(int(row_id))
    if len(dims) != 1:
        return np.empty(0, dtype=np.int64), np.empty((0, 0), dtype=np.float32), frozenset(dims)
    return np.asarray(ids, dtype=np.int64), np.vstack(vectors), frozenset(dims)


def _matrix_scores(np: Any, matrix: Any, query_vector: list[float]) -> Any:
    """The float32 cosine of every matrix row with ``query_vector`` (zeros for a zero
    query). numpy's own ``einsum`` loop, not the BLAS product: BLAS starts a thread pool,
    and on a busy host those threads wait for the CPU (measured on a loaded machine at
    2,000 by 1,536: a median of 20 ms and a worst of 192 ms, against 1.5 ms and 17 ms).
    Pure."""
    query = np.asarray(query_vector, dtype=np.float64)
    norm = float(np.linalg.norm(query))
    if not norm > 0:
        return np.zeros(int(matrix.shape[0]), dtype=np.float32)
    return np.einsum("ij,j->i", matrix, (query / norm).astype(np.float32))


def _rank_rows(
    np: Any, ids: Any, matrix: Any, query_vector: list[float], top_k: int,
) -> list[int]:
    """The row ids to read back and score exactly, best float32 score first: the first
    ``top_k + RERANK_MARGIN``, and every further row whose float32 score is within the
    rounding band of the ``top_k`` cut (one of them may hold a higher exact score than a
    row above it, a near tie). Pure; a large matrix runs it in a worker thread."""
    scores = _matrix_scores(np, matrix, query_vector)
    count = int(scores.shape[0])
    if count == 0:
        return []
    # Stable, so equal scores keep row id order (as the Python path does).
    order = np.argsort(-scores, kind="stable")
    keep = int(top_k) + RERANK_MARGIN
    cut = float(scores[order[min(int(top_k), count) - 1]])
    if math.isfinite(cut):
        # The band is a prefix of ``order``, which sorts by the same float32 scores.
        threshold = cut - _rank_tolerance(len(query_vector))
        keep = max(keep, int(np.count_nonzero(scores.astype(np.float64) >= threshold)))
    return [int(ids[i]) for i in order[:keep]]


class SqlVectorStore(VectorStore):
    """Persistent RAG vectors in a SQL table, ranked by a cached in-process matrix,
    by pgvector ``<=>`` on PostgreSQL for a corpus too large for the matrix (or
    without numpy), else in Python (see the module notes)."""

    def __init__(self, engine: AsyncEngine) -> None:
        self._engine = engine
        self._sm = async_sessionmaker(engine, expire_on_commit=False)
        self._is_pg = engine.url.get_backend_name() == "postgresql"
        # None until known: the engine's start-up probe, or one probe of our own.
        self._pg_native: bool | None = None
        self._pg_failure_logged = False
        self._matrix: _MatrixCache | None = None
        # Bumped by every write through this store; a matrix read before a write is
        # never kept after it.
        self._generation = 0
        self._load_lock_pair: tuple[Any, asyncio.Lock] | None = None

    # ------------------------------------------------------------------ #
    # Writes (each one drops the in-process matrix)
    # ------------------------------------------------------------------ #
    def _invalidate(self) -> None:
        self._generation += 1
        self._matrix = None

    async def add(self, chunks: list[StoredChunk]) -> None:
        usable = [c for c in chunks if c.embedding]
        if not usable:
            return
        try:
            async with self._sm() as session:
                for c in usable:
                    # Upsert by doc_id: a chunk with a known doc_id replaces the prior
                    # one (no duplicates), the same semantics as the in-memory/ES stores.
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
        finally:
            self._invalidate()

    async def clear(self) -> None:
        try:
            async with self._sm() as session:
                await session.execute(delete(RagChunkRow))
                await session.commit()
        finally:
            self._invalidate()

    # ------------------------------------------------------------------ #
    # Search
    # ------------------------------------------------------------------ #
    async def search(self, query_vector: list[float], top_k: int) -> list[tuple[StoredChunk, float]]:
        ranked = (
            isinstance(top_k, int) and not isinstance(top_k, bool) and top_k > 0
            and bool(query_vector)
            and all(isinstance(x, (int, float)) and math.isfinite(x) for x in query_vector)
        )
        if not ranked:
            # Edge inputs keep the original semantics exactly.
            return await self._search_python(query_vector, top_k)
        np = _numpy()
        fingerprint: tuple[int, int] | None = None
        if self._is_pg and await self._pgvector_ready():
            in_database = np is None
            if not in_database:
                fingerprint = await self._fingerprint()
                in_database = fingerprint[0] * len(query_vector) > int(MATRIX_MAX_VALUES)
            if in_database:
                try:
                    return await self._search_pgvector(query_vector, top_k)
                except EmbeddingSpaceMismatch:
                    raise
                except Exception as exc:  # noqa: BLE001 (rank in process for this call)
                    if not self._pg_failure_logged:
                        self._pg_failure_logged = True
                        logger.warning("pgvector ranking failed (%s); ranking in process", exc)
        if np is None:
            return await self._search_python(query_vector, top_k)
        return await self._search_matrix(np, query_vector, top_k, fingerprint=fingerprint)

    async def _search_python(
        self, query_vector: list[float], top_k: int,
    ) -> list[tuple[StoredChunk, float]]:
        """Every row read and scored in Python (the path without numpy)."""
        async with self._sm() as session:
            rows = (
                await session.execute(select(RagChunkRow).order_by(RagChunkRow.id))
            ).scalars().all()
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
            scored.append((_chunk_of(row, emb), _cosine(query_vector, emb)))
        scored.sort(key=lambda t: t[1], reverse=True)
        return scored[:top_k]

    async def _rescore(
        self, ids: list[int], query_vector: list[float], top_k: int,
    ) -> tuple[list[tuple[StoredChunk, float]], bool]:
        """Read the rows ``ids`` back and score them exactly. Returns ``(results,
        complete)``; ``complete`` is False when a row is gone (the ranking was stale)."""
        if not ids:
            return [], True
        rows: list[RagChunkRow] = []
        async with self._sm() as session:
            # In batches, so a very large ``top_k`` never exceeds a driver's bind limit.
            for start in range(0, len(ids), _RESCORE_BATCH):
                batch = ids[start:start + _RESCORE_BATCH]
                rows.extend((
                    await session.execute(select(RagChunkRow).where(RagChunkRow.id.in_(batch)))
                ).scalars().all())
        by_id = {int(row.id): row for row in rows}
        query_norm = _norm_of(query_vector)
        scored: list[tuple[StoredChunk, float]] = []
        for row_id in sorted(by_id):
            row = by_id[row_id]
            emb = list(row.embedding or [])
            if not emb:
                continue
            if len(query_vector) != len(emb):
                raise EmbeddingSpaceMismatch(
                    f"query dim {len(query_vector)} != stored dim {len(emb)}"
                )
            scored.append((_chunk_of(row, emb), _exact_cosine(query_vector, query_norm, emb)))
        scored.sort(key=lambda t: t[1], reverse=True)
        return scored[:top_k], len(by_id) == len(set(ids))

    # -- PostgreSQL with pgvector ------------------------------------------- #
    async def _pgvector_ready(self) -> bool:
        if self._pg_native is None:
            from .engine import pgvector_probed, probe_pgvector

            known = pgvector_probed(self._engine)
            self._pg_native = bool(known) if known is not None else await probe_pgvector(self._engine)
        return bool(self._pg_native)

    async def _search_pgvector(
        self, query_vector: list[float], top_k: int,
    ) -> list[tuple[StoredChunk, float]]:
        dim = len(query_vector)
        literal = "[" + ",".join(repr(float(x)) for x in query_vector) + "]"
        async with self._sm() as session:
            other = await session.scalar(
                text("SELECT dim FROM rag_chunks WHERE dim <> :dim AND dim > 0 LIMIT 1"),
                {"dim": dim},
            )
            if other is not None:
                raise EmbeddingSpaceMismatch(f"query dim {dim} != stored dim {int(other)}")
            result = await session.execute(
                text(_PGVECTOR_RANK_SQL),
                {"q": literal, "dim": dim, "m": int(top_k) + RERANK_MARGIN,
                 "k": int(top_k), "tol": _rank_tolerance(dim)},
            )
            ids = [int(row[0]) for row in result]
        results, _complete = await self._rescore(ids, query_vector, top_k)
        return results

    # -- the in-process matrix ----------------------------------------------- #
    def _load_lock(self) -> asyncio.Lock:
        loop = asyncio.get_running_loop()
        pair = self._load_lock_pair
        if pair is None or pair[0] is not loop:
            pair = (loop, asyncio.Lock())
            self._load_lock_pair = pair
        return pair[1]

    async def _fingerprint(self) -> tuple[int, int]:
        async with self._sm() as session:
            row = (
                await session.execute(
                    select(func.count(), func.max(RagChunkRow.id)).select_from(RagChunkRow)
                )
            ).one()
        return int(row[0] or 0), int(row[1] or 0)

    def _usable(self, cache: _MatrixCache | None, fingerprint: tuple[int, int]) -> bool:
        return (
            cache is not None
            and cache.generation == self._generation
            and cache.fingerprint == fingerprint
            and _clock() - cache.loaded_at < float(MATRIX_CACHE_TTL_SECONDS)
        )

    async def _matrix_cache(
        self, np: Any, fingerprint: tuple[int, int] | None = None,
    ) -> _MatrixCache:
        if fingerprint is None:
            fingerprint = await self._fingerprint()
        if self._usable(self._matrix, fingerprint):
            return self._matrix  # type: ignore[return-value]
        async with self._load_lock():
            fingerprint = await self._fingerprint()
            if self._usable(self._matrix, fingerprint):
                return self._matrix  # type: ignore[return-value]
            generation = self._generation
            async with self._sm() as session:
                result = await session.execute(
                    text("SELECT id, embedding FROM rag_chunks ORDER BY id")
                )
                rows = [(int(row[0]), row[1]) for row in result]
            ids, matrix, dims = await asyncio.to_thread(_build_matrix, np, rows)
            cache = _MatrixCache(
                fingerprint=fingerprint, generation=generation, loaded_at=_clock(),
                ids=ids, matrix=matrix, dims=dims,
            )
            if generation == self._generation:
                self._matrix = cache
            return cache

    async def _search_matrix(
        self, np: Any, query_vector: list[float], top_k: int, *,
        fingerprint: tuple[int, int] | None = None,
    ) -> list[tuple[StoredChunk, float]]:
        try:
            cache = await self._matrix_cache(np, fingerprint)
        except (TypeError, ValueError) as exc:
            logger.warning("RAG vectors could not be cached (%s); scoring in Python", exc)
            return await self._search_python(query_vector, top_k)
        dim = len(query_vector)
        other = next((d for d in sorted(cache.dims) if d != dim), None)
        if other is not None:
            raise EmbeddingSpaceMismatch(f"query dim {dim} != stored dim {other}")
        count = int(cache.ids.shape[0])
        if count == 0:
            return []
        if count * dim > _RANK_OFFLOAD_VALUES:
            # A large matrix is ranked in a worker thread, so the event loop never waits.
            ids = await asyncio.to_thread(
                _rank_rows, np, cache.ids, cache.matrix, query_vector, top_k,
            )
        else:
            ids = _rank_rows(np, cache.ids, cache.matrix, query_vector, top_k)
        results, complete = await self._rescore(ids, query_vector, top_k)
        if complete:
            return results
        # A row the matrix ranked is gone: another process changed the table. Score
        # this call in Python and rebuild the matrix on the next search.
        self._invalidate()
        return await self._search_python(query_vector, top_k)

    # ------------------------------------------------------------------ #
    # Counts and the embedding space
    # ------------------------------------------------------------------ #
    async def count(self) -> int:
        async with self._sm() as session:
            return int((await session.execute(select(func.count()).select_from(RagChunkRow))).scalar() or 0)

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
        try:
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
        finally:
            self._invalidate()

    async def stats(self) -> dict:
        return _stats_of(await self._load_all())


def _chunk_of(row: RagChunkRow, emb: list[float]) -> StoredChunk:
    """A search result's chunk (the same fields every path returns)."""
    return StoredChunk(
        text=row.text,
        source=row.source,
        metadata=dict(row.metadata_json or {}),
        embedding=emb,
        embedding_model=row.embedding_model,
        dim=int(row.dim or len(emb)),
    )
