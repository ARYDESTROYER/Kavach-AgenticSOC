"""Async SQLAlchemy engine factory + schema bootstrap for the SQL state backend.

Postgres-only dependencies (``asyncpg`` driver, ``pgvector``) are NEVER imported
here: SQLAlchemy resolves the ``+asyncpg`` driver lazily from the URL only when a
``postgresql+asyncpg://`` engine is actually created. So importing this module
(and running the whole suite on SQLite/ES) requires only ``sqlalchemy`` +
``aiosqlite`` — the test/dev path.
"""

from __future__ import annotations

import logging
import weakref
from typing import Any

from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from .models import Base

logger = logging.getLogger("tlsoc.stores.sql.engine")

# Sane defaults when state_db_url is not provided.
_DEFAULT_SQLITE_URL = "sqlite+aiosqlite:///./tlsoc.db"


def resolve_db_url(state_backend: str, state_db_url: str | None) -> str:
    """Pick the SQLAlchemy async URL for the configured SQL backend.

    ``sqlite`` defaults to a local file when no URL is given; ``postgres`` MUST be
    given an explicit ``state_db_url`` (we never guess production credentials).
    """
    if state_db_url:
        return state_db_url
    if state_backend == "sqlite":
        return _DEFAULT_SQLITE_URL
    raise ValueError(
        "state_backend='postgres' requires state_db_url "
        "(e.g. postgresql+asyncpg://user:pass@host:5432/tlsoc)"
    )


def build_async_engine(url: str) -> AsyncEngine:
    """Create an async engine. The driver (aiosqlite/asyncpg) is loaded lazily by
    SQLAlchemy from the URL scheme, so asyncpg is imported ONLY for a pg URL."""
    # check_same_thread is a SQLite-only nicety; SQLAlchemy ignores it elsewhere.
    connect_args = {"check_same_thread": False} if url.startswith("sqlite") else {}
    engine = create_async_engine(url, future=True, connect_args=connect_args)
    logger.info("Built async SQL engine (%s)", _safe_url(url))
    return engine


# Outcome of the last in-place schema migration attempt, so a health surface can
# report a DIAGNOSABLE state instead of failing strict audit writes invisibly.
# ``state`` is one of: "not_applicable" (non-PostgreSQL / nothing to do),
# "ok" (schema is current), "failed" (migration needed but could not be applied).
SCHEMA_MIGRATION_STATUS: dict[str, Any] = {
    "state": "not_applicable",
    "detail": "",
    "remediation": "",
}


async def create_all(engine: AsyncEngine) -> None:
    """Create all state tables if absent (idempotent). On Postgres, also ensure the
    pgvector extension is available before any native vector column is used, and
    reconcile in-place column-type migrations for tables that already exist."""
    if engine.url.get_backend_name() == "postgresql":
        await _ensure_pgvector(engine)
        await probe_pgvector(engine)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    await ensure_schema_migrations(engine)
    logger.info("SQL state schema ensured")


# Round 16 (WP06): whether the ``vector`` extension is installed, read ONCE per engine
# from ``pg_extension`` at start (``create_all``). The SQL vector store reads the answer:
# with it, a corpus too large for its in-process matrix (or a process without numpy) is
# ranked in the database with pgvector's ``<=>``. Only a probe that ran is remembered: a
# probe that could not connect leaves no answer, and the store then asks once itself.
_PGVECTOR_PROBES: weakref.WeakKeyDictionary[AsyncEngine, bool] = weakref.WeakKeyDictionary()


def pgvector_probed(engine: AsyncEngine) -> bool | None:
    """The remembered probe for ``engine``: True (installed), False (absent or not
    PostgreSQL) or None (not probed yet)."""
    if engine.url.get_backend_name() != "postgresql":
        return False
    return _PGVECTOR_PROBES.get(engine)


async def probe_pgvector(engine: AsyncEngine) -> bool:
    """Is the pgvector extension installed in ``engine``'s database? One
    ``pg_extension`` read, remembered for the engine's lifetime. Never raises: a failed
    read answers False for this call and is not remembered."""
    if engine.url.get_backend_name() != "postgresql":
        return False
    known = _PGVECTOR_PROBES.get(engine)
    if known is not None:
        return known
    from sqlalchemy import text

    try:
        async with engine.connect() as conn:
            version = await conn.scalar(
                text("SELECT extversion FROM pg_extension WHERE extname = 'vector'")
            )
    except Exception as exc:  # noqa: BLE001 (RAG then ranks in process)
        logger.warning("Could not read pg_extension (%s); RAG ranks vectors in process", exc)
        return False
    available = bool(version)
    _PGVECTOR_PROBES[engine] = available
    if available:
        logger.info("pgvector %s found; RAG can rank a large corpus in the database", version)
    else:
        logger.info("pgvector not installed; RAG ranks vectors in process")
    return available


# ``audit.id`` shipped as 32-bit ``integer`` through 0.1.13 while the strict audit
# path writes a 63-bit derived surrogate key — so EVERY keyed strict write (proposal
# approve/reject, update control-plane records) failed on an existing PostgreSQL
# deployment. ``Base.metadata.create_all`` only creates ABSENT tables, so a fresh
# deploy picks the widened model up automatically but an existing one needs this
# explicit widening. Deliberately scoped to ``audit.id``: it is the only column that
# receives an out-of-range value, and widening the (potentially far larger) usage /
# rag_chunks tables would force an expensive boot-time rewrite for a purely
# theoretical 2.1-billion-row autoincrement ceiling.
_AUDIT_ID_REMEDIATION = (
    "ALTER TABLE audit ALTER COLUMN id TYPE bigint; "
    "ALTER SEQUENCE audit_id_seq AS bigint;"
)


async def ensure_schema_migrations(engine: AsyncEngine) -> dict[str, Any]:
    """Apply idempotent in-place schema migrations. Never raises.

    A failure here must not stop the process from booting (Gate 2), but it must NOT
    be silent either: the outcome is logged at ERROR with the exact remediation SQL
    and recorded in :data:`SCHEMA_MIGRATION_STATUS` for the health surface.
    """
    if engine.url.get_backend_name() != "postgresql":
        _set_migration_status("not_applicable", "", "")
        return dict(SCHEMA_MIGRATION_STATUS)

    from sqlalchemy import text

    try:
        async with engine.begin() as conn:
            current = await conn.scalar(
                text(
                    "SELECT data_type FROM information_schema.columns "
                    "WHERE table_schema = current_schema() "
                    "AND table_name = 'audit' AND column_name = 'id'"
                )
            )
            if current is None:
                # No audit table yet (create_all would have made one) — nothing to do.
                _set_migration_status("ok", "audit table absent", "")
                return dict(SCHEMA_MIGRATION_STATUS)
            if str(current) == "bigint":
                _set_migration_status("ok", "audit.id is bigint", "")
                return dict(SCHEMA_MIGRATION_STATUS)

            logger.warning(
                "Migrating audit.id from %s to bigint; strict audit writes "
                "(proposal approve/reject) fail until this completes",
                current,
            )
            await conn.execute(text("ALTER TABLE audit ALTER COLUMN id TYPE bigint"))
            sequence = await conn.scalar(
                text("SELECT pg_get_serial_sequence('audit', 'id')")
            )
            if sequence:
                # Quoted identifier already fully qualified by pg_get_serial_sequence.
                await conn.execute(text(f"ALTER SEQUENCE {sequence} AS bigint"))
        logger.info("Migrated audit.id to bigint")
        _set_migration_status("ok", "audit.id widened to bigint", "")
    except Exception as exc:  # noqa: BLE001 — boot must survive; visibility is mandatory
        logger.error(
            "SCHEMA MIGRATION FAILED: audit.id could not be widened to bigint (%s). "
            "Privileged strict audit writes — including proposal approve/reject — "
            "will FAIL until this is applied manually: %s",
            exc,
            _AUDIT_ID_REMEDIATION,
        )
        _set_migration_status("failed", str(exc), _AUDIT_ID_REMEDIATION)
    return dict(SCHEMA_MIGRATION_STATUS)


def _set_migration_status(state: str, detail: str, remediation: str) -> None:
    SCHEMA_MIGRATION_STATUS["state"] = state
    SCHEMA_MIGRATION_STATUS["detail"] = detail
    SCHEMA_MIGRATION_STATUS["remediation"] = remediation


async def _ensure_pgvector(engine: AsyncEngine) -> None:
    """Best-effort ``CREATE EXTENSION IF NOT EXISTS vector`` on Postgres.

    Lazily imports nothing pg-specific (raw SQL); failures (e.g. extension not
    installed / insufficient privilege) are logged and tolerated. :func:`probe_pgvector`
    then records whether the extension is there; without it the SQL vector store ranks
    the stored JSON embeddings in process (no native vector column either way)."""
    from sqlalchemy import text

    try:
        async with engine.begin() as conn:
            await conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
        logger.info("pgvector extension ensured")
    except Exception as exc:  # noqa: BLE001
        logger.warning("Could not ensure pgvector extension (%s); RAG uses JSON cosine", exc)


def _safe_url(url: str) -> str:
    """Redact credentials for logging."""
    if "@" in url and "://" in url:
        scheme, rest = url.split("://", 1)
        host = rest.split("@", 1)[1]
        return f"{scheme}://***@{host}"
    return url
