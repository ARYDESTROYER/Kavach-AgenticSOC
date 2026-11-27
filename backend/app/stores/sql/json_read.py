"""A JSON column read that a stored ``\\u0000`` or lone surrogate cannot break.

The SQL backend keeps its documents in ``json`` columns (``cases.doc``, ``audit.doc``,
``usage.doc``, ``kv.value``). On PostgreSQL ``doc ->> 'field'`` de-escapes EVERY
string in the document, so one ``\\u0000`` or one unpaired surrogate escape
(``\\ud800``) anywhere in a row fails the expression, whichever field it reads:
``unsupported Unicode escape sequence``. A row stored by an older build (or by any
writer before ``app.stored_text`` cleaned audit rows on write) still holds them, and
append-only audit rows are never rewritten, so the read itself must tolerate them.

:func:`readable_json` wraps a JSON column for indexing (``readable_json(Row.doc)[key]``
with ``.as_string()``, ``.as_float()`` or ``.as_integer()``):

* PostgreSQL reads a copy of the document with those escapes removed, built only for a
  row whose text holds a NUL escape or a surrogate escape; every other row is read as
  stored. The removal is one left-to-right scan of the document text that keeps an
  escaped backslash (``\\\\``) and a valid surrogate pair intact, so an escaped
  backslash followed by ``u0000`` (the TEXT ``\\u0000``) is never touched.
* Every other dialect (SQLite's ``json_extract`` never de-escapes into text that can
  fail) compiles to the bare column: the generated SQL is unchanged.

The stored document is never modified (#2: audit rows stay append-only).
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import JSON
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.sql.functions import FunctionElement

# One alternation, scanned left to right (PostgreSQL alternation is greedy, so the
# longest branch wins at a position): an escaped backslash and a valid surrogate pair
# are matched and put back (groups 1 and 2); a NUL escape and a lone surrogate escape
# match no group and are removed. JSON escapes always use a lowercase ``u``.
_STRIP_PATTERN = (
    r"(\\\\)"
    r"|(\\u[dD][89abAB][0-9a-fA-F]{2}\\u[dD][c-fC-F][0-9a-fA-F]{2})"
    r"|\\u0000"
    r"|\\u[dD][89a-fA-F][0-9a-fA-F]{2}"
)


def _escape_literal(value: str) -> str:
    """``value`` as a PostgreSQL ``E''`` literal (backslashes doubled, quotes doubled),
    so the SQL means the same whatever ``standard_conforming_strings`` is."""
    return "E'" + value.replace("\\", "\\\\").replace("'", "''") + "'"


_PATTERN_SQL = _escape_literal(_STRIP_PATTERN)
_KEEP_SQL = _escape_literal(r"\1\2")
#: The rewrite runs only for a row whose text holds a NUL escape or any surrogate escape
#: (a plain substring test and one short search), so ordinary non-ASCII text does not
#: pay for it. A false positive (an escaped backslash before ``u0000``) is harmless.
_NUL_SQL = _escape_literal("\\u0000")
_SURROGATE_SQL = _escape_literal(r"\\u[dD][89a-fA-F]")


class readable_json(FunctionElement):  # noqa: N801 (reads like the SQL function it stands for)
    """A JSON column as a read can index it on every dialect (see the module doc)."""

    type = JSON()
    name = "readable_json"
    inherit_cache = True

    def __init__(self, column: Any) -> None:
        super().__init__(column)


def _column(element: readable_json, compiler: Any, **kw: Any) -> str:
    return compiler.process(element.clauses.clauses[0], **kw)


@compiles(readable_json)
def _compile_default(element: readable_json, compiler: Any, **kw: Any) -> str:
    return _column(element, compiler, **kw)


@compiles(readable_json, "postgresql")
def _compile_postgresql(element: readable_json, compiler: Any, **kw: Any) -> str:
    column = _column(element, compiler, **kw)
    as_text = f"CAST({column} AS TEXT)"
    return (
        f"(CASE WHEN strpos({as_text}, {_NUL_SQL}) > 0 OR {as_text} ~ {_SURROGATE_SQL} "
        f"THEN CAST(regexp_replace({as_text}, {_PATTERN_SQL}, {_KEEP_SQL}, 'g') AS JSON) "
        f"ELSE {column} END)"
    )


__all__ = ["readable_json"]
