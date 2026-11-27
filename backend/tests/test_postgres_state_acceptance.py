"""Acceptance tests for the SQL state backend against a REAL PostgreSQL server.

These are the tests the SQLite-backed offline suite structurally cannot run. The
``audit.id`` defect shipped precisely because SQLite's ``INTEGER`` is already
64-bit: the deterministic NEGATIVE 63-bit surrogate key that
``SqlAuditRepository.write_strict`` derives from ``AuditDoc.event_id`` inserted
happily there, while on PostgreSQL every keyed strict write raised
``asyncpg.exceptions.DataError: ... value out of int32 range`` and took proposal
approve AND reject down with it (both append a decision audit row before
finalising, so both always returned 503).

Two things are proven here:

* a FRESH ``create_all()`` produces a 64-bit ``audit.id`` and accepts a keyed
  strict write;
* an EXISTING v0.1.13 deployment (``id SERIAL PRIMARY KEY``) is widened in place
  by :func:`app.stores.sql.engine.ensure_schema_migrations` — losing no rows,
  keeping plain autoincrement working, and running idempotently.
  ``Base.metadata.create_all`` only creates ABSENT tables, so without that
  in-place migration an upgraded deployment would stay broken forever.

Running these tests requires a PostgreSQL server. Point ``POSTGRES_TEST_DB_URL``
(or the backend's own ``STATE_DB_URL``, when it already names a PostgreSQL
database) at one::

    POSTGRES_TEST_DB_URL=postgresql+asyncpg://user:pass@127.0.0.1:5432/postgres \\
        python -m pytest -q tests/test_postgres_state_acceptance.py

With neither set the whole module SKIPS — a developer without PostgreSQL never
sees a failure. CI's ``postgres-redis`` lane exports it against its live service,
so a regression fails the lane. The credentials URL is used only to CREATE a
throwaway scratch database per test; nothing is written to the database it names.
"""

from __future__ import annotations

import json
import os
import random
import uuid

import pytest
import pytest_asyncio
from sqlalchemy import select, text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import create_async_engine

from app.constants import ActionType
from app.models import AuditDoc
from app.stores.sql import SqlAuditRepository, build_async_engine, create_all
from app.stores.sql.engine import SCHEMA_MIGRATION_STATUS, ensure_schema_migrations
from app.stores.sql.models import AuditRow

INT32_MAX = (1 << 31) - 1


def _configured_postgres_url() -> str:
    """The admin URL for the acceptance run, or ``""`` when PostgreSQL is absent.

    ``POSTGRES_TEST_DB_URL`` is the explicit opt-in. ``STATE_DB_URL`` — the same
    variable the backend and CI's ``postgres-redis`` lane already use — is honoured
    as a fallback ONLY when it actually names a PostgreSQL database, so a developer
    running the ordinary SQLite/ES suite is never dragged into these tests.
    """
    for name in ("POSTGRES_TEST_DB_URL", "STATE_DB_URL"):
        candidate = (os.environ.get(name) or "").strip()
        if candidate.startswith("postgresql"):
            return candidate
    return ""


POSTGRES_URL = _configured_postgres_url()

pytestmark = pytest.mark.skipif(
    not POSTGRES_URL,
    reason=(
        "no PostgreSQL configured; set POSTGRES_TEST_DB_URL (or a postgresql "
        "STATE_DB_URL) to run the real-PostgreSQL state acceptance tests"
    ),
)


# --------------------------------------------------------------------------- #
# Per-test isolation: every test gets its OWN throwaway database.
# --------------------------------------------------------------------------- #
@pytest_asyncio.fixture
async def pg_engine():
    """A dedicated scratch database, created and dropped around each test.

    A whole database (rather than a schema) keeps the tests hermetic — table
    creation, the sequence, and ``pg_get_serial_sequence`` all resolve in the
    default schema exactly as they do in a real deployment — and guarantees two
    tests can never observe each other's ``audit`` table.
    """
    admin = create_async_engine(POSTGRES_URL, isolation_level="AUTOCOMMIT")
    database = f"tlsoc_test_{uuid.uuid4().hex[:16]}"
    try:
        async with admin.connect() as conn:
            await conn.execute(text(f'CREATE DATABASE "{database}"'))

        url = make_url(POSTGRES_URL).set(database=database)
        engine = build_async_engine(url.render_as_string(hide_password=False))
        try:
            yield engine
        finally:
            await engine.dispose()
            async with admin.connect() as conn:
                await conn.execute(text(f'DROP DATABASE IF EXISTS "{database}" WITH (FORCE)'))
    finally:
        await admin.dispose()


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def _decision_doc(*, event_id: str, ts: str, summary: str = "approve") -> AuditDoc:
    """A privileged proposal-decision audit row — the exact shape that broke."""
    return AuditDoc(
        event_id=event_id,
        ts=ts,
        case_id="case-0001",
        surface="proposal",
        actor="analyst@example.com",
        action_type=ActionType.PROPOSAL,
        result_summary=summary,
    )


async def _audit_id_type(engine) -> str | None:
    async with engine.connect() as conn:
        return await conn.scalar(
            text(
                "SELECT data_type FROM information_schema.columns "
                "WHERE table_schema = current_schema() "
                "AND table_name = 'audit' AND column_name = 'id'"
            )
        )


async def _audit_sequence_type(engine) -> str | None:
    async with engine.connect() as conn:
        sequence = await conn.scalar(text("SELECT pg_get_serial_sequence('audit', 'id')"))
        if not sequence:
            return None
        name = sequence.split(".")[-1].strip('"')
        return await conn.scalar(
            text(
                "SELECT data_type FROM information_schema.sequences "
                "WHERE sequence_schema = current_schema() AND sequence_name = :name"
            ),
            {"name": name},
        )


async def _recycle(engine) -> None:
    """Drop pooled connections after an in-place ``ALTER TABLE``.

    asyncpg caches a prepared-statement plan per connection, so a connection that
    queried ``audit`` BEFORE the widening raises ``InvalidCachedStatementError`` the
    first time it is reused afterwards. A real deployment never sees this —
    ``create_all()`` runs once during ``AppState`` bootstrap, before the pool has
    served any ``audit`` query — but these tests deliberately read the table on both
    sides of the migration, so they recycle the pool the way a restart would.
    """
    await engine.dispose()


async def _audit_rows(engine) -> list[tuple[int, str, dict]]:
    async with engine.connect() as conn:
        result = await conn.execute(
            select(AuditRow.id, AuditRow.ts, AuditRow.doc).order_by(AuditRow.id)
        )
        return [(row[0], row[1], row[2]) for row in result.all()]


# The ``audit`` table EXACTLY as version 0.1.13 shipped it: a 32-bit ``SERIAL``
# primary key. This is the literal DDL SQLAlchemy compiled from the pre-fix
# ``AuditRow`` (``Integer, primary_key=True, autoincrement=True``) on the
# PostgreSQL dialect, indexes included.
_V0113_AUDIT_DDL = (
    """
    CREATE TABLE audit (
        id SERIAL NOT NULL,
        ts VARCHAR(64) NOT NULL,
        case_id VARCHAR(255),
        action_type VARCHAR(64) NOT NULL,
        doc JSON NOT NULL,
        PRIMARY KEY (id)
    )
    """,
    "CREATE INDEX ix_audit_ts ON audit (ts)",
    "CREATE INDEX ix_audit_case_id ON audit (case_id)",
)


async def _create_v0113_audit_table(engine) -> None:
    async with engine.begin() as conn:
        for statement in _V0113_AUDIT_DDL:
            await conn.execute(text(statement))


async def _seed_legacy_rows(engine, count: int = 5) -> list[tuple[int, str, dict]]:
    """Insert pre-upgrade history through the SERIAL sequence (no explicit ids)."""
    async with engine.begin() as conn:
        for index in range(count):
            await conn.execute(
                text(
                    "INSERT INTO audit (ts, case_id, action_type, doc) "
                    "VALUES (:ts, :case_id, :action_type, CAST(:doc AS json))"
                ),
                {
                    "ts": f"2026-08-0{index + 1}T00:00:00Z",
                    "case_id": "case-0001",
                    "action_type": ActionType.POLL.value,
                    "doc": json.dumps(
                        {
                            "ts": f"2026-08-0{index + 1}T00:00:00Z",
                            "case_id": "case-0001",
                            "action_type": ActionType.POLL.value,
                            "result_summary": f"pre-upgrade history {index}",
                        }
                    ),
                },
            )
    return await _audit_rows(engine)


def _assert_v0113_reconstruction_is_faithful() -> None:
    """Guard the reconstruction: same columns, in the same order, as today's model."""
    assert [column.name for column in AuditRow.__table__.columns] == [
        "id",
        "ts",
        "case_id",
        "action_type",
        "doc",
    ]


# --------------------------------------------------------------------------- #
# 1. Fresh deployment
# --------------------------------------------------------------------------- #
async def test_fresh_create_all_gives_a_bigint_audit_id_and_accepts_a_keyed_write(
    pg_engine,
) -> None:
    """A brand-new PostgreSQL deployment must take keyed strict writes on day one."""
    await create_all(pg_engine)

    assert await _audit_id_type(pg_engine) == "bigint"
    assert await _audit_sequence_type(pg_engine) == "bigint"
    assert SCHEMA_MIGRATION_STATUS["state"] == "ok"

    repo = SqlAuditRepository(pg_engine)
    event_id = "proposal-decision:p-42:approve"
    await repo.write_strict(_decision_doc(event_id=event_id, ts="2026-08-06T00:00:00Z"))

    rows = await _audit_rows(pg_engine)
    assert len(rows) == 1
    assert rows[0][0] < 0 and abs(rows[0][0]) > INT32_MAX
    assert rows[0][2]["event_id"] == event_id

    # Idempotent retry (equivalent payload, later clock) still appends nothing.
    await repo.write_strict(_decision_doc(event_id=event_id, ts="2026-08-06T00:00:09Z"))
    assert len(await _audit_rows(pg_engine)) == 1

    # A genuine semantic collision still fails closed on PostgreSQL too.
    with pytest.raises(RuntimeError, match="audit event id collision"):
        await repo.write_strict(
            _decision_doc(
                event_id=event_id, ts="2026-08-06T00:00:19Z", summary="reject"
            )
        )


# --------------------------------------------------------------------------- #
# 2. THE MIGRATION — an existing v0.1.13 deployment
# --------------------------------------------------------------------------- #
async def test_existing_v0113_schema_rejects_keyed_writes_then_migrates_cleanly(
    pg_engine,
) -> None:
    """Reproduce the shipped 32-bit deployment, then prove the in-place widening.

    Without :func:`ensure_schema_migrations` this stays broken forever:
    ``Base.metadata.create_all`` sees an existing ``audit`` table and skips it.
    """
    _assert_v0113_reconstruction_is_faithful()
    await _create_v0113_audit_table(pg_engine)
    before = await _seed_legacy_rows(pg_engine, count=5)
    assert len(before) == 5

    # --- the defect, reproduced on the shipped schema --------------------- #
    assert await _audit_id_type(pg_engine) == "integer"
    assert await _audit_sequence_type(pg_engine) == "integer"

    repo = SqlAuditRepository(pg_engine)
    with pytest.raises(DBAPIError) as excinfo:
        await repo.write_strict(
            _decision_doc(event_id="proposal-decision:p-42:approve", ts="2026-08-06T00:00:00Z")
        )
    # asyncpg reports this either client-side while encoding the parameter
    # ("invalid input for query argument $1: ... (value out of int32 range)") or
    # server-side ("integer out of range"), depending on how the statement is
    # prepared. Both are the same 32-bit column defect.
    message = str(excinfo.value)
    assert "int32" in message or "integer out of range" in message, (
        f"expected the 32-bit overflow error, got: {excinfo.value!r}"
    )
    assert len(await _audit_rows(pg_engine)) == 5, "the failed write must append nothing"

    # --- the fix: boot the current build against that deployment ----------- #
    await create_all(pg_engine)
    await _recycle(pg_engine)

    # (a) the column is widened
    assert await _audit_id_type(pg_engine) == "bigint"
    # (b) so is the sequence backing it
    assert await _audit_sequence_type(pg_engine) == "bigint"
    assert SCHEMA_MIGRATION_STATUS["state"] == "ok"
    assert SCHEMA_MIGRATION_STATUS["detail"] == "audit.id widened to bigint"

    # (c) NO ROWS WERE LOST — ids, timestamps and payloads are byte-identical
    after = await _audit_rows(pg_engine)
    assert after == before

    # (d) the keyed strict write that used to be impossible now succeeds
    await repo.write_strict(
        _decision_doc(event_id="proposal-decision:p-42:approve", ts="2026-08-06T00:00:00Z")
    )
    keyed = [row for row in await _audit_rows(pg_engine) if row[0] < 0]
    assert len(keyed) == 1
    assert abs(keyed[0][0]) > INT32_MAX
    assert keyed[0][2]["event_id"] == "proposal-decision:p-42:approve"

    # (e) plain autoincrement writes still work, continuing the existing sequence
    await repo.write_strict(
        AuditDoc(
            ts="2026-08-06T01:00:00Z",
            case_id="case-0001",
            action_type=ActionType.POLL,
            result_summary="post-migration telemetry",
        )
    )
    positives = [row[0] for row in await _audit_rows(pg_engine) if row[0] > 0]
    assert positives == sorted(positives)
    assert positives[-1] == max(row[0] for row in before) + 1

    # (f) re-running is idempotent: no error, no change, no data loss
    snapshot = await _audit_rows(pg_engine)
    status = await ensure_schema_migrations(pg_engine)
    assert status["state"] == "ok"
    assert status["detail"] == "audit.id is bigint"
    await create_all(pg_engine)
    assert await _audit_id_type(pg_engine) == "bigint"
    assert await _audit_sequence_type(pg_engine) == "bigint"
    assert await _audit_rows(pg_engine) == snapshot


async def test_ensure_schema_migrations_tolerates_an_absent_audit_table(
    pg_engine,
) -> None:
    """Boot must survive a database with no state schema at all (Gate 2)."""
    status = await ensure_schema_migrations(pg_engine)
    assert status["state"] == "ok"
    assert status["detail"] == "audit table absent"
    assert status["remediation"] == ""


async def test_failed_migration_is_loud_diagnosable_and_recoverable(
    pg_engine, caplog
) -> None:
    """A migration that cannot be applied must NEVER be silent.

    PostgreSQL refuses ``ALTER COLUMN ... TYPE`` while a view depends on the
    column — a realistic operator-added reporting view is enough to block the
    widening. Boot must still complete (a schema problem must not take the process
    down, Gate 2), but the outcome has to be logged at ERROR and recorded in
    ``SCHEMA_MIGRATION_STATUS`` with the exact remediation SQL. Once the blocker is
    removed the very same call must succeed — the migration is not one-shot.
    """
    import logging

    await _create_v0113_audit_table(pg_engine)
    before = await _seed_legacy_rows(pg_engine, count=3)
    async with pg_engine.begin() as conn:
        await conn.execute(text("CREATE VIEW audit_recent AS SELECT id, ts FROM audit"))

    with caplog.at_level(logging.ERROR, logger="tlsoc.stores.sql.engine"):
        status = await ensure_schema_migrations(pg_engine)

    assert status["state"] == "failed"
    assert status["detail"], "a failed migration must explain itself"
    assert "ALTER TABLE audit ALTER COLUMN id TYPE bigint" in status["remediation"]
    assert "ALTER SEQUENCE audit_id_seq AS bigint" in status["remediation"]
    assert any(
        "SCHEMA MIGRATION FAILED" in record.getMessage() for record in caplog.records
    ), caplog.text
    # Left diagnosably broken rather than silently half-migrated, and no data touched.
    assert await _audit_id_type(pg_engine) == "integer"
    assert await _audit_rows(pg_engine) == before

    # Remediation applied by the operator → the next boot completes the migration.
    async with pg_engine.begin() as conn:
        await conn.execute(text("DROP VIEW audit_recent"))
    assert (await ensure_schema_migrations(pg_engine))["state"] == "ok"
    await _recycle(pg_engine)
    assert await _audit_id_type(pg_engine) == "bigint"
    assert await _audit_rows(pg_engine) == before
    await SqlAuditRepository(pg_engine).write_strict(
        _decision_doc(event_id="proposal-decision:p-99:reject", ts="2026-08-06T02:00:00Z")
    )
    assert len(await _audit_rows(pg_engine)) == len(before) + 1


# --------------------------------------------------------------------------- #
# Round 16 (WP06): RAG vector search ranks with pgvector in the database.
# --------------------------------------------------------------------------- #
# The PostgreSQL image carries the ``vector`` extension, so ``create_all`` creates it
# and probes ``pg_extension`` once. The SQL vector store ranks with its in-process
# matrix, and with ``<=>`` over the existing JSON column (no schema change) for a corpus
# too large for the matrix or a process without numpy. These tests prove the three
# search paths (pgvector, the in-process matrix and pure Python) return the same chunks
# with the same exact scores, and that the database path still refuses a query from
# another embedding space.
def _vector_chunks(seed: int, dim: int) -> tuple[list, list[float]]:
    from app.tools.vectorstore import StoredChunk

    rng = random.Random(seed)
    base = [rng.uniform(-1.0, 1.0) for _ in range(dim)]

    def chunk(text_value: str, emb: list[float]) -> StoredChunk:
        return StoredChunk(
            text=text_value, source="mitre", metadata={"document_id": text_value},
            embedding=emb, embedding_model="m-test", dim=len(emb),
        )

    chunks = [chunk(f"c{i}", [rng.uniform(-1.0, 1.0) for _ in range(dim)]) for i in range(150)]
    chunks += [chunk(f"dup{i}", list(base)) for i in range(10)]  # exact ties
    chunks.append(chunk("zero", [0.0] * dim))  # pgvector ranks its distance as NaN
    return chunks, base


def _vector_shape(results: list) -> list[tuple[str, float]]:
    return [(chunk.text, score) for chunk, score in results]


async def test_pgvector_ranking_matches_the_matrix_and_python_paths(pg_engine, monkeypatch) -> None:
    from app.stores.sql import SqlVectorStore
    from app.stores.sql import vectorstore as sqlvec
    from app.stores.sql.engine import pgvector_probed
    from app.tools.vectorstore import _cosine

    await create_all(pg_engine)
    assert pgvector_probed(pg_engine) is True
    dim = 48
    chunks, base = _vector_chunks(16, dim)
    store = SqlVectorStore(pg_engine)
    await store.add(chunks)

    native_calls = {"n": 0}
    real_native = store._search_pgvector

    async def counted(query, top_k):
        native_calls["n"] += 1
        return await real_native(query, top_k)

    monkeypatch.setattr(store, "_search_pgvector", counted)
    rng = random.Random(61)
    queries = [[rng.uniform(-1.0, 1.0) for _ in range(dim)] for _ in range(4)]
    queries += [list(base), [0.0] * dim]
    for query in queries:
        for top_k in (1, 5, 20, 400):
            with monkeypatch.context() as m:
                m.setattr(sqlvec, "MATRIX_MAX_VALUES", 0)  # too large: rank in the database
                native = await store.search(query, top_k)
            matrix = await store.search(query, top_k)  # a small corpus: the matrix
            with monkeypatch.context() as m:
                m.setattr(sqlvec, "_numpy", lambda: None)
                m.setattr(store, "_pg_native", False)
                python = await store.search(query, top_k)
            assert _vector_shape(native) == _vector_shape(matrix) == _vector_shape(python)
            expected = sorted(
                ((c.text, _cosine(query, c.embedding)) for c in chunks),
                key=lambda t: t[1], reverse=True,
            )[:top_k]
            assert _vector_shape(native) == expected
    assert native_calls["n"] == len(queries) * 4  # only the database legs
    assert store._matrix is not None
    assert store._pg_failure_logged is False  # the database path never fell back


async def test_a_float_near_tie_never_hides_the_best_chunk_on_any_path(pg_engine, monkeypatch) -> None:
    """pgvector and the matrix both score in float32: more than ``RERANK_MARGIN`` rows
    that tie with the best row there (but not in float64) must not push it out of the
    rows read back (review fix; it used to drop the chunk the Python path ranks first)."""
    from app.stores.sql import SqlVectorStore
    from app.stores.sql import vectorstore as sqlvec
    from app.tools.vectorstore import StoredChunk

    await create_all(pg_engine)
    store = SqlVectorStore(pg_engine)

    def chunk(text_value: str, emb: list[float]) -> StoredChunk:
        return StoredChunk(text=text_value, source="mitre", embedding=emb,
                           embedding_model="m-test", dim=len(emb))

    await store.add([chunk(f"near{i}", [1.0, 1e-4, 0.0, 0.0]) for i in range(20)]
                    + [chunk("exact", [1.0, 0.0, 0.0, 0.0])])
    query = [1.0, 0.0, 0.0, 0.0]
    for top_k in (1, 5, 21):
        with monkeypatch.context() as m:
            m.setattr(sqlvec, "MATRIX_MAX_VALUES", 0)  # rank in the database
            native = await store.search(query, top_k)
        matrix = await store.search(query, top_k)
        with monkeypatch.context() as m:
            m.setattr(sqlvec, "_numpy", lambda: None)
            m.setattr(store, "_pg_native", False)
            python = await store.search(query, top_k)
        assert _vector_shape(native) == _vector_shape(matrix) == _vector_shape(python)
        assert native[0][0].text == "exact" and native[0][1] == 1.0
    assert store._pg_failure_logged is False


async def test_without_numpy_postgresql_ranks_in_the_database(pg_engine, monkeypatch) -> None:
    from app.stores.sql import SqlVectorStore
    from app.stores.sql import vectorstore as sqlvec

    await create_all(pg_engine)
    chunks, base = _vector_chunks(19, 16)
    store = SqlVectorStore(pg_engine)
    await store.add(chunks)
    monkeypatch.setattr(sqlvec, "_numpy", lambda: None)
    results = await store.search(base, 3)
    assert [c.text for c, _ in results] == ["dup0", "dup1", "dup2"]
    assert store._matrix is None and store._pg_native is True
    assert store._pg_failure_logged is False


async def test_pgvector_ranking_still_refuses_another_embedding_space(pg_engine) -> None:
    from app.stores.sql import SqlVectorStore
    from app.tools.vectorstore import EmbeddingSpaceMismatch, StoredChunk

    await create_all(pg_engine)
    chunks, base = _vector_chunks(17, 12)
    store = SqlVectorStore(pg_engine)
    await store.add(chunks[:20])
    with pytest.raises(EmbeddingSpaceMismatch):
        await store._search_pgvector(base[:6], 3)
    with pytest.raises(EmbeddingSpaceMismatch):
        await store.search(base[:6], 3)
    await store.add([StoredChunk(text="wide", source="mitre", embedding=[0.5] * 6,
                                 embedding_model="m-other", dim=6)])
    with pytest.raises(EmbeddingSpaceMismatch):
        await store._search_pgvector(base, 3)
    with pytest.raises(EmbeddingSpaceMismatch):
        await store.search(base, 3)
    assert store._pg_failure_logged is False


async def test_a_store_without_pgvector_on_postgresql_ranks_in_process(pg_engine) -> None:
    from app.stores.sql import SqlVectorStore

    await create_all(pg_engine)
    chunks, base = _vector_chunks(18, 16)
    store = SqlVectorStore(pg_engine)
    store._pg_native = False  # as when the probe found no extension
    await store.add(chunks)
    results = await store.search(base, 3)
    assert [c.text for c, _ in results] == ["dup0", "dup1", "dup2"]
    assert store._matrix is not None  # ranked by the in-process matrix
