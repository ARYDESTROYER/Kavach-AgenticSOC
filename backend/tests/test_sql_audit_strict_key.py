"""Regression coverage for the 64-bit ``audit.id`` surrogate key (SQLite-runnable).

``SqlAuditRepository.write_strict`` maps a privileged ``AuditDoc.event_id`` to a
deterministic NEGATIVE 63-bit surrogate primary key so the database provides
cross-process exactly-once insertion. ``AuditRow.id`` shipped as a 32-bit
``Integer`` through 0.1.13, so on PostgreSQL EVERY keyed strict write raised
``asyncpg.exceptions.DataError: value out of int32 range`` — proposal approve AND
reject were 100% impossible (both append a decision audit row before finalising,
so both always returned 503). SQLite's ``INTEGER`` is already 64-bit, which is
exactly why the SQLite-backed offline suite never noticed.

Everything here runs offline on ``sqlite+aiosqlite`` (or with no database at all).
:func:`test_audit_id_ddl_is_bigint_on_postgresql` is the one that would have caught
the original defect: it compiles the DDL against the PostgreSQL dialect without
needing a server. The live-server proof lives in
``tests/test_postgres_state_acceptance.py``.
"""

from __future__ import annotations

import hashlib
import re

import pytest
import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.dialects import postgresql, sqlite
from sqlalchemy.schema import CreateTable

from app.constants import ActionType
from app.models import AuditDoc
from app.stores.sql import SqlAuditRepository, build_async_engine, create_all
from app.stores.sql.engine import SCHEMA_MIGRATION_STATUS, ensure_schema_migrations
from app.stores.sql.models import AuditRow

INT32_MAX = (1 << 31) - 1
INT64_MAX = (1 << 63) - 1


def _derived_key(event_id: str) -> int:
    """Mirror of the surrogate-key derivation in ``SqlAuditRepository.write_strict``.

    Duplicated on purpose: if the production derivation ever changes shape this
    test must fail loudly rather than silently follow it.
    """
    digest = hashlib.sha256(event_id.encode("utf-8")).digest()
    return -(int.from_bytes(digest[:8], "big") & INT64_MAX or 1)


def _audit_id_ddl(dialect) -> str:
    """The ``id`` column line from ``CREATE TABLE audit`` for one dialect."""
    ddl = str(CreateTable(AuditRow.__table__).compile(dialect=dialect))
    for line in ddl.splitlines():
        stripped = line.strip()
        if stripped.startswith("id "):
            return stripped.rstrip(",")
    raise AssertionError(f"no id column in compiled DDL:\n{ddl}")


# --------------------------------------------------------------------------- #
# The DDL contract — a pure unit test, no server required.
# --------------------------------------------------------------------------- #
def test_derived_strict_key_always_exceeds_int32_range() -> None:
    """The surrogate key derivation CANNOT fit a 32-bit column.

    This is the premise the whole regression rests on: the derived key uses 63
    bits, so any realistic ``event_id`` overflows ``integer`` by many orders of
    magnitude. The real approve/reject keys are included verbatim.
    """
    event_ids = [
        "proposal-decision:p-1:approve",
        "proposal-decision:p-1:reject",
        "proposal-decision:8f2c1b9e-0000-4b6a-9f11-2f0a5c7d3e41:approve",
        "update:job:abcd1234:submitted",
        "k",
        "",
    ]
    for event_id in event_ids:
        if not event_id:
            continue  # falsy event_id keeps the plain autoincrement path
        key = _derived_key(event_id)
        assert key < 0, f"{event_id!r} must map to a negative key, got {key}"
        assert abs(key) > INT32_MAX, (
            f"{event_id!r} derived key {key} unexpectedly fits int32 — the "
            "derivation changed and this regression's premise no longer holds"
        )
        assert abs(key) <= INT64_MAX


def test_audit_id_ddl_is_bigint_on_postgresql() -> None:
    """THE regression test for the shipped defect.

    On PostgreSQL ``audit.id`` must compile to a 64-bit column (``BIGSERIAL`` for
    an autoincrement primary key). With the pre-fix ``Integer`` this asserts
    ``SERIAL``/``INTEGER`` and fails — no PostgreSQL server needed.
    """
    dialect = postgresql.dialect()
    assert AuditRow.__table__.c.id.type.compile(dialect=dialect) == "BIGINT"

    column_ddl = _audit_id_ddl(dialect)
    assert re.match(r"^id BIGSERIAL\b", column_ddl), column_ddl
    # ``BIGSERIAL`` contains ``SERIAL`` as a substring, so match the 32-bit forms
    # as whole words to keep the negative assertion meaningful.
    assert not re.search(r"\b(SERIAL|INTEGER)\b", column_ddl), (
        f"audit.id compiled to a 32-bit PostgreSQL column ({column_ddl}); every "
        "keyed strict write (proposal approve/reject) would fail with "
        "'value out of int32 range'"
    )


def test_audit_id_ddl_stays_literal_integer_on_sqlite() -> None:
    """SQLite must keep a literal ``INTEGER PRIMARY KEY``.

    That is the only spelling SQLite aliases to the rowid (and the only one
    AUTOINCREMENT accepts); ``BIGINT PRIMARY KEY`` silently loses rowid aliasing.
    SQLite's ``INTEGER`` is 64-bit anyway, so the ``with_variant`` costs nothing.
    """
    dialect = sqlite.dialect()
    assert AuditRow.__table__.c.id.type.compile(dialect=dialect) == "INTEGER"
    assert _audit_id_ddl(dialect) == "id INTEGER NOT NULL"


def test_audit_id_variant_is_scoped_to_sqlite_only() -> None:
    """Every non-SQLite dialect gets a true BIGINT, not just PostgreSQL."""
    from sqlalchemy.dialects import mysql

    assert AuditRow.__table__.c.id.type.compile(dialect=mysql.dialect()) == "BIGINT"


# --------------------------------------------------------------------------- #
# Behavioural coverage on SQLite (the offline suite's backend).
# --------------------------------------------------------------------------- #
@pytest_asyncio.fixture
async def engine():
    eng = build_async_engine("sqlite+aiosqlite:///:memory:")
    await create_all(eng)
    yield eng
    await eng.dispose()


def _decision_doc(
    *,
    event_id: str,
    ts: str,
    result_summary: str = "approved by analyst",
) -> AuditDoc:
    return AuditDoc(
        event_id=event_id,
        ts=ts,
        case_id="case-0001",
        surface="proposals",
        actor="analyst@example.com",
        action_type=ActionType.PROPOSAL,
        result_summary=result_summary,
    )


async def test_keyed_strict_write_succeeds_and_stores_the_derived_key(engine) -> None:
    """A keyed strict write lands, under the exact derived negative key."""
    repo = SqlAuditRepository(engine)
    event_id = "proposal-decision:p-42:approve"
    await repo.write_strict(_decision_doc(event_id=event_id, ts="2026-08-06T00:00:00Z"))

    async with engine.connect() as conn:
        rows = (await conn.execute(select(AuditRow.id, AuditRow.doc))).all()
    assert len(rows) == 1
    stored_id, stored_doc = rows[0]
    assert stored_id == _derived_key(event_id)
    assert abs(stored_id) > INT32_MAX
    assert stored_doc["event_id"] == event_id


async def test_keyed_strict_write_is_idempotent_for_an_equivalent_payload(engine) -> None:
    """A retry with the same semantics appends nothing and keeps the FIRST ts."""
    repo = SqlAuditRepository(engine)
    event_id = "proposal-decision:p-42:reject"
    await repo.write_strict(_decision_doc(event_id=event_id, ts="2026-08-06T00:00:00Z"))
    # A later retry after an ambiguous response: identical semantics, new clock.
    await repo.write_strict(_decision_doc(event_id=event_id, ts="2026-08-06T00:00:09Z"))

    async with engine.connect() as conn:
        rows = (await conn.execute(select(AuditRow.id, AuditRow.doc))).all()
    assert len(rows) == 1, "an idempotent retry must not append a second row"
    assert rows[0][0] == _derived_key(event_id)
    assert rows[0][1]["ts"] == "2026-08-06T00:00:00Z", "first append retains its ts"


async def test_keyed_strict_write_fails_closed_on_a_semantic_collision(engine) -> None:
    """Same key, DIFFERENT payload must fail closed — never overwrite audit."""
    repo = SqlAuditRepository(engine)
    event_id = "proposal-decision:p-42:approve"
    await repo.write_strict(_decision_doc(event_id=event_id, ts="2026-08-06T00:00:00Z"))

    with pytest.raises(RuntimeError, match="audit event id collision"):
        await repo.write_strict(
            _decision_doc(
                event_id=event_id,
                ts="2026-08-06T00:00:09Z",
                result_summary="rejected by a different analyst",
            )
        )

    async with engine.connect() as conn:
        rows = (await conn.execute(select(AuditRow.doc))).all()
    assert len(rows) == 1
    assert rows[0][0]["result_summary"] == "approved by analyst", "append-only preserved"


async def test_unkeyed_writes_still_autoincrement_alongside_a_keyed_row(engine) -> None:
    """Plain telemetry keeps working after a keyed row lands, and stays ordered.

    ``id`` exists to break ties between millisecond-identical ``ts`` values, so the
    invariant that must hold on every dialect is: auto-assigned ids are unique and
    strictly increasing in insertion order. (The absolute values differ by backend —
    PostgreSQL keeps its own untouched sequence, while SQLite derives the next rowid
    from the current maximum — so the test asserts the ordering contract, not a sign.)
    """
    repo = SqlAuditRepository(engine)
    await repo.write_strict(
        _decision_doc(event_id="proposal-decision:p-7:approve", ts="2026-08-06T00:00:00Z")
    )
    for index in range(3):
        await repo.write_strict(
            AuditDoc(
                ts="2026-08-06T00:00:05Z",  # identical clock — id IS the tiebreaker
                case_id="case-0001",
                action_type=ActionType.PROPOSAL,
                result_summary=f"telemetry {index}",
            )
        )

    async with engine.connect() as conn:
        rows = (
            await conn.execute(select(AuditRow.id, AuditRow.doc).order_by(AuditRow.id))
        ).all()
    assert len(rows) == 4
    ids = [row_id for row_id, _ in rows]
    assert len(set(ids)) == 4, "auto-assigned audit ids must be unique"
    assert ids == sorted(ids)

    telemetry = [doc["result_summary"] for _, doc in rows if doc.get("event_id") is None]
    assert telemetry == ["telemetry 0", "telemetry 1", "telemetry 2"], (
        "id must preserve insertion order for rows sharing a timestamp"
    )


async def test_forgiving_write_swallows_a_collision_but_strict_does_not(engine) -> None:
    """``write`` stays fail-open telemetry; only ``write_strict`` gates durability."""
    repo = SqlAuditRepository(engine)
    event_id = "proposal-decision:p-9:approve"
    await repo.write_strict(_decision_doc(event_id=event_id, ts="2026-08-06T00:00:00Z"))
    # Must not raise — the forgiving path logs and continues.
    await repo.write(
        _decision_doc(
            event_id=event_id,
            ts="2026-08-06T00:00:09Z",
            result_summary="conflicting summary",
        )
    )

    async with engine.connect() as conn:
        count = len((await conn.execute(select(AuditRow.id))).all())
    assert count == 1


# --------------------------------------------------------------------------- #
# ensure_schema_migrations() on a non-PostgreSQL engine.
# --------------------------------------------------------------------------- #
async def test_ensure_schema_migrations_is_a_no_op_off_postgresql(engine) -> None:
    """SQLite has nothing to widen: report ``not_applicable`` and touch nothing."""
    status = await ensure_schema_migrations(engine)
    assert status == {"state": "not_applicable", "detail": "", "remediation": ""}
    assert SCHEMA_MIGRATION_STATUS["state"] == "not_applicable"

    # Idempotent, and the audit table still accepts a 63-bit keyed write afterwards.
    assert (await ensure_schema_migrations(engine))["state"] == "not_applicable"
    repo = SqlAuditRepository(engine)
    await repo.write_strict(
        _decision_doc(event_id="proposal-decision:p-1:approve", ts="2026-08-06T00:00:00Z")
    )
    async with engine.connect() as conn:
        assert len((await conn.execute(select(AuditRow.id))).all()) == 1


async def test_create_all_reports_migration_status_on_sqlite() -> None:
    """``create_all`` drives the migration hook, so booting SQLite records status."""
    eng = build_async_engine("sqlite+aiosqlite:///:memory:")
    try:
        await create_all(eng)
        assert SCHEMA_MIGRATION_STATUS["state"] == "not_applicable"
    finally:
        await eng.dispose()
