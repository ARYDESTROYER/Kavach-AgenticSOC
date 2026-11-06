"""The audit log export (Round 14 SPEC §4.5.6): job kind ``audit_export``.

A person with ``audit:export`` (super admin, SOC manager and auditor by default, D5)
signs in again (D6) and asks for one plain file of the audit rows the audit log page
shows: CSV for a spreadsheet or JSON Lines for a SIEM (D7). This module holds what the
submit route and the durable job share:

* **The question.** The filters are the read API's own (:func:`app.api.routes_audit.
  _filters` and :func:`app.audit.query.build_predicate`), so the file holds exactly the
  rows ``GET /api/audit`` shows for the same scope, search text and filters. The time
  range is two absolute ISO 8601 instants with a zone (the instants the export dialog
  showed and counted); date math such as ``now-7d`` is refused, because a relative
  range would move between the count and the read. The read API resolves the two
  instants too (a ``to`` given to the second covers that whole second), so the count,
  the page and the file agree at the range's edges. The read ends before the millisecond
  the job was submitted in (:func:`submission_cap`), so a row written after the person
  pressed Export (including the ``audit.export_requested`` row of this very export) is
  never in the file, however far ahead the browser clock was, on every store: the cap
  applies at the millisecond, as Elasticsearch keeps time.
* **The count.** At most :data:`app.models.AUDIT_EXPORT_MAX_ROWS` (100,000) rows. The
  submit route counts first and refuses a larger export; the job counts again before it
  reads (:func:`count_events`), checks the exact total inside the read's own snapshot
  (an Elasticsearch point-in-time, a SQL high-water time) on its first page, and stops
  if more rows than the cap ever arrive. An export is never partial: it fails with
  ``audit_export_too_large`` instead, and a store that cannot count exactly
  (``audit_export_unverifiable``) or a read that ends before its counted total
  (``audit_export_incomplete``) fails too. Nothing is ever silently truncated.
* **The order.** Oldest first, always (the dialog says so).
* **The read.** Server-side pages of :data:`EXPORT_PAGE_SIZE` rows through the read
  API's store calls (``search_page``), inside one snapshot per store. Every page
  boundary is a job checkpoint, so a cancel, a lost permission or an expired fresh
  sign-in stops the export there, and progress is reported in events. Free disk
  space is checked before every write, keeping the data export's reserve free, so a
  large export never fills the volume the state store and the audit log share
  (``audit_export_no_space``).
* **The file.** One plain file in the private artifact root, never a ZIP:
  ``agentic-soc-audit_<from>_<to>.csv`` or ``.ndjson``, named after the instants the
  dialog showed (``2026-10-18T151000Z``).

  CSV (RFC 4180): a UTF-8 byte order mark (so a spreadsheet reads the file as UTF-8),
  one header row of :data:`CSV_COLUMNS`, records ending in CRLF, every text field
  quoted with inner quotes doubled, numbers bare, ``true``/``false`` for flags, an
  empty field for "not recorded". Each row is the read API's record
  (:func:`app.api.routes_audit.to_record`): the stored fields plus the record id, the
  category and friendly event name, and the ``*_derived`` flags of legacy rows;
  ``ts`` is ISO 8601 UTC; ``client`` and ``target`` are flattened into dotted columns;
  ``tool_input``, ``changes`` and ``truncated_fields`` are JSON text. Every text field
  is formula-defused (:func:`defuse_formula`): the rule set is the shared fixture
  ``webui/src/lib/csv-formula.contract.json``, which the Console's own CSV exports read
  too. A lone UTF-16 surrogate, which UTF-8 cannot encode, is written as U+FFFD.

  JSON Lines: each stored row exactly as the store returned it, one JSON object per
  line, UTF-8 (a row holding a lone surrogate is written with ASCII escapes instead,
  which is the same JSON value).

Every value is written as stored, never interpreted (#9): ``prompt_excerpt`` and
``tool_output_summary`` keep their untrusted-data fences, and the formula defusal only
stops a spreadsheet from running a cell; it never changes what a cell says.

Pure helpers plus two async functions over the audit repositories; the durable job
around them (leases, cancellation, the artifact, its audit rows) is
``JobRunner._audit_log_export`` in :mod:`app.engine.jobs`.
"""

from __future__ import annotations

import asyncio
import errno
import json
import math
import os
import re
from collections import deque
from dataclasses import dataclass, field, replace
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable, Mapping, Sequence

from ..audit.query import AuditFilters, build_predicate
from ..models import (
    AUDIT_COUNT_MAX_CAP,
    AUDIT_EXPORT_MAX_ROWS,
    AuditRecord,
    AuditTarget,
)
from ..stores.base import AuditCursorExpired
from ..utils import parse_es_timestamp

#: The export formats (D7) and what each file is.
EXPORT_FORMATS: tuple[str, ...] = ("csv", "jsonl")
EXPORT_SUFFIXES: dict[str, str] = {"csv": ".csv", "jsonl": ".ndjson"}
EXPORT_CONTENT_TYPES: dict[str, str] = {
    "csv": "text/csv; charset=utf-8",
    "jsonl": "application/x-ndjson",
}
EXPORT_FORMAT_LABELS: dict[str, str] = {"csv": "CSV", "jsonl": "JSON Lines"}
EXPORT_SCOPE_LABELS: dict[str, str] = {
    "people": "People and settings",
    "agent": "Agent activity",
    "all": "All",
}
#: Rows per store read (the largest page the bundled stores serve).
EXPORT_PAGE_SIZE = 1000
#: Written first in a CSV file so a spreadsheet reads it as UTF-8.
UTF8_BOM = "﻿"

#: A text cell whose first character, after any run of ASCII spaces, is one of these
#: is formula-defused with a leading apostrophe: ``= + - @``, tab, carriage return,
#: line feed and the full-width ``＝ ＋ － ＠``. The shared fixture
#: ``webui/src/lib/csv-formula.contract.json`` pins the rule for both stacks.
FORMULA_LEADS = frozenset("=+-@\t\r\n＝＋－＠")

#: The CSV header: every field of an audit record (SPEC §4.5.10), with ``target`` and
#: ``client`` flattened into dotted columns. ``tool_input``, ``changes`` and
#: ``truncated_fields`` are JSON text.
CSV_COLUMNS: tuple[str, ...] = (
    "record_id",
    "ts",
    "outcome",
    "outcome_derived",
    "category",
    "action",
    "event_label",
    "action_type",
    "surface",
    "actor",
    "actor_type",
    "actor_type_derived",
    "actor_role",
    "target.type",
    "target.id",
    "target.label",
    "target.revision",
    "case_id",
    "source_id",
    "result_summary",
    "tool_output_summary",
    "query_text",
    "prompt_excerpt",
    "model",
    "tool_name",
    "tool_input",
    "changes",
    "client.ip",
    "client.ip_source",
    "client.peer",
    "client.forwarded_for",
    "client.user_agent",
    "session_ref",
    "request_id",
    "run_id",
    "event_id",
    "app_version",
    "build_sha",
    "demo",
    "truncated_fields",
)

#: An absolute instant: a date, a time to the minute or finer, and a zone.
_INSTANT_RE = re.compile(
    r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:[Zz]|[+-]\d{2}:\d{2})"
)
_SURROGATES = re.compile("[\ud800-\udfff]")

CsvCell = str | int | float | bool | None


# --------------------------------------------------------------------------- #
# Refusals (each message starts with its code, so the Jobs page and the Console
# can name the reason; the rest is plain copy)
# --------------------------------------------------------------------------- #
class AuditExportError(RuntimeError):
    """The export could not be made; nothing is kept. ``str(error)`` is
    ``"<code>: <message>"`` (the job's failure reason); ``message`` is the copy."""

    code = "audit_export_failed"

    def __init__(self, message: str) -> None:
        super().__init__(f"{self.code}: {message}")
        self.message = message


class AuditExportTooLarge(AuditExportError):
    code = "audit_export_too_large"

    def __init__(self) -> None:
        super().__init__(
            f"More than {AUDIT_EXPORT_MAX_ROWS:,} events match these filters, so nothing "
            "was exported. Narrow the filters or the time range and export again."
        )


class AuditExportUnverifiable(AuditExportError):
    code = "audit_export_unverifiable"

    def __init__(self) -> None:
        super().__init__(
            "This audit store cannot count the matching events exactly, so nothing was "
            "exported."
        )


class AuditExportIncomplete(AuditExportError):
    code = "audit_export_incomplete"

    def __init__(self, read: int, total: int) -> None:
        super().__init__(
            f"Only {read:,} of the {total:,} matching events could be read, so the file "
            "was not kept. Export again."
        )


class AuditExportExpired(AuditExportError):
    code = "audit_export_expired"

    def __init__(self) -> None:
        super().__init__(
            "The audit store's snapshot expired while the export was read, so the file "
            "was not kept. Export again."
        )


class AuditExportUnreadable(AuditExportError):
    code = "audit_unavailable"

    def __init__(self) -> None:
        super().__init__("The audit log could not be read, so nothing was exported. Export again.")


class AuditExportUnaudited(AuditExportError):
    """The ``audit.exported`` row could not be appended, so the file never became
    visible (audit before visible, E16)."""

    code = "audit_unavailable"

    def __init__(self) -> None:
        super().__init__(
            "The export could not be recorded in the audit log, so the file was not kept. "
            "Export again."
        )


class AuditExportNoSpace(AuditExportError):
    """The artifact volume ran short of free space (the data export's own reserve is
    kept free, so the state store and the audit log beside it can still be written)."""

    code = "audit_export_no_space"

    def __init__(self) -> None:
        super().__init__(
            "There is not enough free disk space to write this export, so nothing was kept."
        )


#: Why a running export lost its authority (the ``code`` of the runner's
#: ``JobAuthorityLost``), as the plain sentence the job's failure reason carries.
_DENIED_MESSAGES: dict[str, str] = {
    "job_demo_mode": (
        "Demo Mode was turned on, so the export stopped and no file was kept. Turn Demo "
        "Mode off and export again."
    ),
    "job_permission_lost": (
        "You no longer have permission to export the audit log, so the export stopped "
        "and no file was kept."
    ),
    "job_reauth_expired": (
        "The sign-in for this export expired before it finished, so no file was kept. "
        "Sign in again and export again."
    ),
}


class AuditExportDenied(AuditExportError):
    """The export lost its authority while it was queued or running: Demo Mode was
    turned on, a grant was removed or the account deactivated, or the fresh sign-in
    expired. ``cause`` is the runner's code for which one."""

    code = "audit_export_denied"

    def __init__(self, cause: str | None = None) -> None:
        self.cause = cause or ""
        super().__init__(
            _DENIED_MESSAGES.get(
                self.cause, "The export lost its permission to run, so no file was kept."
            )
        )


def refuse_unless_exportable(count: int, relation: str) -> None:
    """Raise unless ``(count, relation)`` is an exact count within the cap."""
    if count > AUDIT_EXPORT_MAX_ROWS:
        raise AuditExportTooLarge()
    if relation != "eq":
        raise AuditExportUnverifiable()


# --------------------------------------------------------------------------- #
# The question: params -> filters, instants and the file name
# --------------------------------------------------------------------------- #
def parse_instant(raw: Any, side: str) -> datetime:
    """One end of the range: an absolute ISO 8601 instant with a zone, in UTC.

    Raises ``422 audit_invalid_time`` (the read API's code) for anything else,
    including date math such as ``now-7d``, a bare date and a time without a zone."""
    from ..api.routes_audit import _invalid_time

    text = raw.strip() if isinstance(raw, str) else ""
    if not _INSTANT_RE.fullmatch(text):
        raise _invalid_time(
            f"'{side}' must be an absolute ISO 8601 time with a zone, such as "
            "2026-10-18T15:10:00Z."
        )
    candidate = text[:-1] + "+00:00" if text[-1] in "Zz" else text
    try:
        # A time at the very edge of the calendar (0001-01-01 ahead of UTC, 9999-12-31
        # behind it) parses but has no UTC instant: OverflowError, refused the same way.
        parsed = datetime.fromisoformat(candidate).astimezone(timezone.utc)
    except (ValueError, OverflowError) as exc:
        raise _invalid_time(f"'{side}' is not a valid time.") from exc
    return parsed


def export_range(params: Mapping[str, Any]) -> tuple[datetime, datetime]:
    """The absolute ``(from, to)`` the dialog showed, validated (``from`` <= ``to``)."""
    from ..api.routes_audit import _invalid_time

    ts_from = parse_instant(params.get("from"), "from")
    ts_to = parse_instant(params.get("to"), "to")
    if ts_from > ts_to:
        raise _invalid_time("'from' must not be later than 'to'.")
    return ts_from, ts_to


def export_filters(params: Mapping[str, Any], *, read_until: datetime | None = None) -> AuditFilters:
    """The read API's :class:`AuditFilters` for an export's params.

    Validated by the read API itself, so every refusal is its coded ``422``
    (``audit_invalid_filter`` or ``audit_invalid_time``). The range is the read API's
    own reading of the two instants, so ``GET /api/audit/count`` (the dialog's
    "Export N events?"), ``GET /api/audit`` and the file hold the same rows: a ``to``
    given to the second covers that whole second, a ``to`` given to the minute that
    whole minute, and both ends apply at the millisecond, as the store keeps time
    (``routes_audit._parse_time``). :func:`export_range` only validates the instants
    and names the file. ``read_until`` (the moment the job was submitted) caps the
    range's end at :func:`submission_cap`: the read ends before the millisecond of
    submission, so rows written after it are never read, on any store."""
    from ..api.routes_audit import _filters

    # Absolute instants with a zone, ``from`` <= ``to`` (the read API alone would also
    # take date math, which moves between the count and the read).
    _ts_from, ts_to = export_range(params)
    raw_filters = params.get("filters") or {}
    if not isinstance(raw_filters, Mapping):
        raw_filters = {}

    def text(name: str) -> str | None:
        value = raw_filters.get(name)
        return value if isinstance(value, str) else None

    built = _filters(
        scope=params.get("scope") if isinstance(params.get("scope"), str) else None,
        q=params.get("q") if isinstance(params.get("q"), str) else None,
        action=text("action"),
        event=text("event"),
        actor=text("actor"),
        actor_contains=text("actor_contains"),
        actor_kind=text("actor_kind"),
        outcome=text("outcome"),
        surface=text("surface"),
        case_id=text("case_id"),
        source_id=text("source_id"),
        target=text("target"),
        ip=text("ip"),
        from_=str(params["from"]).strip(),
        to=str(params["to"]).strip(),
        now=ts_to,
    )
    if read_until is None:
        return built
    cap = submission_cap(read_until)
    return replace(built, ts_to=cap if built.ts_to is None else min(built.ts_to, cap))


def submission_cap(read_until: datetime) -> datetime:
    """The last instant an export reads: the end of the millisecond before the one it
    was submitted in.

    Elasticsearch keeps a ``date`` field to the millisecond and cuts an ``lte`` bound
    to its millisecond, so a cap at the submission's own microsecond would still read
    every row of that millisecond there, including rows written after the person
    pressed Export (this export's ``audit.export_requested`` row among them), while
    SQL, which keeps microseconds, would leave them out. Ending at the last
    microsecond of the previous millisecond gives every store the same rows: none of
    the submission millisecond. The submit route's count, the job's recount and its
    read all share this cap, so the job's total and the file still agree."""
    cap = read_until.astimezone(timezone.utc)
    floor = cap.replace(microsecond=cap.microsecond - cap.microsecond % 1000)
    return floor - timedelta(microseconds=1)


def _stamp(instant: datetime) -> str:
    return instant.astimezone(timezone.utc).strftime("%Y-%m-%dT%H%M%SZ")


def export_file_name(fmt: str, ts_from: datetime, ts_to: datetime) -> str:
    """``agentic-soc-audit_2026-10-18T151000Z_2026-10-25T151000Z.csv`` (SPEC §4.5.6)."""
    return f"agentic-soc-audit_{_stamp(ts_from)}_{_stamp(ts_to)}{EXPORT_SUFFIXES[fmt]}"


def export_target(job_id: str, file_name: str) -> AuditTarget:
    """The ``export`` target every row of one export names (requested, exported,
    downloaded, failed), so the inspector can pair them."""
    return AuditTarget(type="export", id=job_id, label=file_name)


def describe_request(params: Mapping[str, Any], count: int) -> str:
    """The plain one-line summary of an ``audit.export_requested`` row."""
    ts_from, ts_to = export_range(params)
    fmt = EXPORT_FORMAT_LABELS.get(str(params.get("format")), str(params.get("format")))
    scope = EXPORT_SCOPE_LABELS.get(str(params.get("scope")), str(params.get("scope")))
    noun = "event" if count == 1 else "events"
    return (
        f"requested an audit export of {count:,} {noun} as {fmt}: {scope}, "
        f"{_utc_text(ts_from)} to {_utc_text(ts_to)}, oldest first"
    )[:1000]


# --------------------------------------------------------------------------- #
# CSV (RFC 4180, formula-defused)
# --------------------------------------------------------------------------- #
def defuse_formula(text: str) -> str:
    """Neutralise a spreadsheet formula lead: a leading apostrophe when the first
    character after any ASCII spaces is in :data:`FORMULA_LEADS` (``=HYPERLINK(…)``
    stays the rule's name, never a live link). Only the lead changes; the text does
    not."""
    stripped = text.lstrip(" ")
    if stripped and stripped[0] in FORMULA_LEADS:
        return "'" + text
    return text


def csv_field(value: CsvCell) -> str:
    """One CSV field: text defused then quoted (inner quotes doubled), integers and
    finite numbers bare, flags ``true``/``false``, ``None`` (not recorded) empty."""
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return repr(value) if math.isfinite(value) else ""
    text = defuse_formula(str(value))
    return '"' + text.replace('"', '""') + '"'


def csv_record(cells: Sequence[CsvCell]) -> str:
    """One RFC 4180 record, ending in CRLF."""
    return ",".join(csv_field(cell) for cell in cells) + "\r\n"


def csv_header() -> str:
    return UTF8_BOM + csv_record(CSV_COLUMNS)


def _utc_text(instant: datetime) -> str:
    return instant.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _ts_text(raw: Any) -> str | None:
    """The row time as ISO 8601 UTC; a value that does not parse is kept as stored."""
    if raw in (None, ""):
        return None
    parsed = parse_es_timestamp(raw)
    if parsed is None:
        return str(raw)
    return _utc_text(parsed)


def _json_text(value: Any) -> str | None:
    if value is None:
        return None
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)


def csv_cells(record: AuditRecord) -> list[CsvCell]:
    """The cells of one record, in :data:`CSV_COLUMNS` order."""
    target = record.target
    client = record.client
    changes = (
        [change.model_dump(mode="json") for change in record.changes]
        if record.changes is not None
        else None
    )
    values: dict[str, CsvCell] = {
        "record_id": record.record_id,
        "ts": _ts_text(record.ts),
        "outcome": record.outcome,
        "outcome_derived": record.outcome_derived,
        "category": record.category,
        "action": record.action,
        "event_label": record.event_label,
        "action_type": record.action_type,
        "surface": record.surface,
        "actor": record.actor,
        "actor_type": record.actor_type,
        "actor_type_derived": record.actor_type_derived,
        "actor_role": record.actor_role,
        "target.type": target.type if target is not None else None,
        "target.id": target.id if target is not None else None,
        "target.label": target.label if target is not None else None,
        "target.revision": target.revision if target is not None else None,
        "case_id": record.case_id,
        "source_id": record.source_id,
        "result_summary": record.result_summary,
        "tool_output_summary": record.tool_output_summary,
        "query_text": record.query_text,
        "prompt_excerpt": record.prompt_excerpt,
        "model": record.model,
        "tool_name": record.tool_name,
        "tool_input": _json_text(record.tool_input),
        "changes": _json_text(changes),
        "client.ip": client.ip if client is not None else None,
        "client.ip_source": client.ip_source if client is not None else None,
        "client.peer": client.peer if client is not None else None,
        "client.forwarded_for": client.forwarded_for if client is not None else None,
        "client.user_agent": client.user_agent if client is not None else None,
        "session_ref": record.session_ref,
        "request_id": record.request_id,
        "run_id": record.run_id,
        "event_id": record.event_id,
        "app_version": record.app_version,
        "build_sha": record.build_sha,
        "demo": record.demo,
        "truncated_fields": _json_text(list(record.truncated_fields)),
    }
    return [values[column] for column in CSV_COLUMNS]


def csv_line(doc: Mapping[str, Any], record_id: str | None, *, demo: bool) -> str:
    """One stored row as a CSV record (the read API's projection of it)."""
    from ..api.routes_audit import to_record

    stored = {k: v for k, v in doc.items() if isinstance(k, str)}
    try:
        record = to_record(stored, record_id or "mem:0", demo=demo)
    except Exception:  # noqa: BLE001 (a row is never dropped: keep its core text)
        record = AuditRecord.model_validate({
            "record_id": record_id or "mem:0",
            "ts": str(stored.get("ts") or ""),
            "actor": str(stored.get("actor") or ""),
            "action_type": str(stored.get("action_type") or ""),
            "demo": demo,
        })
    cells = csv_cells(record)
    if record_id is None:
        # A row the store could not give an id: exported, with an empty id cell.
        cells[CSV_COLUMNS.index("record_id")] = None
    return csv_record(cells)


def jsonl_line(doc: Mapping[str, Any]) -> bytes:
    """One stored row, unmodified, as one JSON Lines record (UTF-8)."""
    try:
        return (json.dumps(doc, ensure_ascii=False, separators=(",", ":"), default=str) + "\n").encode("utf-8")
    except UnicodeEncodeError:
        # A lone surrogate cannot be UTF-8; ASCII escapes carry the same JSON value.
        return (json.dumps(doc, ensure_ascii=True, separators=(",", ":"), default=str) + "\n").encode("utf-8")


def _encode_csv(text: str) -> bytes:
    return _SURROGATES.sub("�", text).encode("utf-8")


# --------------------------------------------------------------------------- #
# The reads
# --------------------------------------------------------------------------- #
def _sources(state: Any, scope: str | None) -> list[Any]:
    from ..api.routes_audit import _sources as read_sources

    return read_sources(state, scope)


async def count_events(state: Any, filters: AuditFilters) -> tuple[int, str]:
    """The read API's count (``GET /api/audit/count``) for the export's filters, with
    the cap one past the export ceiling: ``(count, "eq" | "gte")``. Raises
    :class:`AuditExportUnreadable` when a store cannot be counted."""
    try:
        counts = await asyncio.gather(*(
            source.repo.count_matching(build_predicate(filters.with_scope(source.scope)), cap=AUDIT_COUNT_MAX_CAP)
            for source in _sources(state, filters.scope)
        ))
    except Exception as exc:  # noqa: BLE001 (any store failure is "could not be read")
        raise AuditExportUnreadable() from exc
    total = sum(int(count) for count, _relation in counts)
    relation = "gte" if any(rel == "gte" for _count, rel in counts) else "eq"
    return total, relation


@dataclass
class _Reader:
    """One store's oldest-first read inside its own snapshot."""

    repo: Any
    predicate: Any
    demo: bool
    order: int
    buffer: deque[Any] = field(default_factory=deque)
    position: Any = None
    fetched: bool = False
    exhausted: bool = False
    total: int = 0
    relation: str = "eq"
    read: int = 0

    async def fill(self) -> None:
        try:
            page = await self.repo.search_page(
                self.predicate,
                order="asc",
                limit=EXPORT_PAGE_SIZE,
                cursor=self.position,
                track_total=AUDIT_COUNT_MAX_CAP,
            )
        except AuditCursorExpired as exc:
            raise AuditExportExpired() from exc
        except Exception as exc:  # noqa: BLE001 (any store failure is "could not be read")
            raise AuditExportUnreadable() from exc
        self.fetched = True
        # Every page reports the total inside the read's snapshot; the latest is kept.
        self.total, self.relation = int(page.total), str(page.relation)
        self.buffer.extend(page.hits)
        if page.hits:
            self.position = page.hits[-1].position
        elif page.start is not None:
            self.position = page.start
        self.exhausted = bool(page.exhausted) or not page.hits

    async def close(self) -> None:
        if self.fetched and self.position is not None:
            try:
                await self.repo.close_search_cursor(self.position)
            except Exception:  # noqa: BLE001 (a snapshot left open expires on its own)
                pass


def _merge_key(hit: Any) -> float:
    parsed = parse_es_timestamp(hit.doc.get("ts")) if isinstance(hit.doc, Mapping) else None
    return parsed.timestamp() if parsed is not None else float("-inf")


def _record_id(hit: Any, demo: bool) -> str | None:
    from ..models import encode_audit_record_id

    try:
        return encode_audit_record_id(hit.store, hit.ref, index=hit.index, demo=demo)
    except ValueError:
        return None


@dataclass(frozen=True)
class ExportWritten:
    """What :func:`write_export` wrote: the rows, and the snapshot total it checked."""

    rows: int
    snapshot_total: int


#: ``errno`` values that mean the volume (or the account's quota on it) is full.
_NO_SPACE_ERRNOS = frozenset(
    code for code in (getattr(errno, "ENOSPC", None), getattr(errno, "EDQUOT", None)) if code
)


async def write_export(
    state: Any,
    *,
    filters: AuditFilters,
    fmt: str,
    path: Path,
    checkpoint: Callable[[int], Awaitable[Any]],
    ensure_capacity: Callable[[int], Awaitable[Any]] | None = None,
) -> ExportWritten:
    """Write every row matching ``filters``, oldest first, to ``path``.

    ``checkpoint(rows_written)`` runs before every store page (the cancellation,
    authority and progress boundary); it raises to stop. The first page of each store
    checks the exact total inside that store's snapshot; more than the cap, or a total
    the store cannot state exactly, stops the export before a row is written, and the
    rows read must equal that total at the end. ``ensure_capacity(nbytes)`` runs
    before every write of ``nbytes`` (the free-space boundary); it raises to stop, so
    an export never eats the space the state store and the audit log need. Raises an
    :class:`AuditExportError` for each of those, for an expired snapshot or a store
    that cannot be read, and :class:`AuditExportNoSpace` when the volume is full. The
    caller deletes the file on any failure."""
    if fmt not in EXPORT_FORMATS:
        raise ValueError(f"unknown audit export format {fmt!r}")
    readers = [
        _Reader(source.repo, build_predicate(filters.with_scope(source.scope)), bool(source.demo), index)
        for index, source in enumerate(_sources(state, filters.scope))
    ]
    handle = await asyncio.to_thread(path.open, "wb")
    rows = 0

    async def emit(data: bytes) -> None:
        if ensure_capacity is not None:
            await ensure_capacity(len(data))
        try:
            await asyncio.to_thread(handle.write, data)
        except OSError as exc:
            if exc.errno in _NO_SPACE_ERRNOS:
                raise AuditExportNoSpace() from exc
            raise

    try:
        if fmt == "csv":
            await emit(_encode_csv(csv_header()))
        # The first page of every store, then the snapshot totals, before any row.
        for reader in readers:
            await checkpoint(rows)
            await reader.fill()
        snapshot_total = sum(reader.total for reader in readers)
        if snapshot_total > AUDIT_EXPORT_MAX_ROWS:
            raise AuditExportTooLarge()
        if any(reader.relation != "eq" for reader in readers):
            refuse_unless_exportable(snapshot_total, "gte")
        chunk: list[bytes] = []
        while True:
            for reader in readers:
                if not reader.buffer and not reader.exhausted:
                    if chunk:
                        await emit(b"".join(chunk))
                        chunk = []
                    await checkpoint(rows)
                    await reader.fill()
                    if reader.total > AUDIT_EXPORT_MAX_ROWS or reader.relation != "eq":
                        refuse_unless_exportable(reader.total, reader.relation)
            live = [reader for reader in readers if reader.buffer]
            if not live:
                break
            reader = min(live, key=lambda r: (_merge_key(r.buffer[0]), r.order))
            hit = reader.buffer.popleft()
            reader.read += 1
            rows += 1
            if rows > AUDIT_EXPORT_MAX_ROWS:
                raise AuditExportTooLarge()
            doc = hit.doc if isinstance(hit.doc, Mapping) else {}
            if fmt == "csv":
                chunk.append(_encode_csv(csv_line(doc, _record_id(hit, reader.demo), demo=reader.demo)))
            else:
                chunk.append(jsonl_line(doc))
            if len(chunk) >= EXPORT_PAGE_SIZE:
                await emit(b"".join(chunk))
                chunk = []
        if chunk:
            await emit(b"".join(chunk))
        for reader in readers:
            if reader.read != reader.total:
                raise AuditExportIncomplete(
                    sum(r.read for r in readers), sum(r.total for r in readers)
                )

        def sync() -> None:
            handle.flush()
            os.fsync(handle.fileno())

        try:
            await asyncio.to_thread(sync)
        except OSError as exc:
            # A buffered write can first meet a full volume when it is flushed.
            if exc.errno in _NO_SPACE_ERRNOS:
                raise AuditExportNoSpace() from exc
            raise
        return ExportWritten(rows=rows, snapshot_total=sum(r.total for r in readers))
    finally:
        await asyncio.to_thread(handle.close)
        for reader in readers:
            await reader.close()


__all__ = [
    "CSV_COLUMNS",
    "EXPORT_CONTENT_TYPES",
    "EXPORT_FORMATS",
    "EXPORT_PAGE_SIZE",
    "EXPORT_SUFFIXES",
    "FORMULA_LEADS",
    "UTF8_BOM",
    "AuditExportDenied",
    "AuditExportError",
    "AuditExportExpired",
    "AuditExportIncomplete",
    "AuditExportNoSpace",
    "AuditExportTooLarge",
    "AuditExportUnaudited",
    "AuditExportUnreadable",
    "AuditExportUnverifiable",
    "ExportWritten",
    "count_events",
    "csv_cells",
    "csv_field",
    "csv_line",
    "csv_record",
    "defuse_formula",
    "describe_request",
    "export_file_name",
    "export_filters",
    "submission_cap",
    "export_range",
    "export_target",
    "jsonl_line",
    "parse_instant",
    "refuse_unless_exportable",
    "write_export",
]
