"""The runbook library catalog (Round 14 SPEC §4.10.5, §4.10.12, §4.10.13, §4.10.15).

What ``api/routes_runbooks.py`` serves, kept out of the route module so it can be
tested on its own and reused (A7c's candidates picker and the metrics read the same
catalog). This module owns:

* **Views**: the library list (:func:`library`), one runbook's detail
  (:func:`detail`) and one version (:func:`version_doc`), built from the 12 bundled
  runbooks (``engine.runbook_model.load_builtin_runbooks``, read-only, versioned by
  the release) and the operator library (``stores.runbook_library``). Draft and
  in-review versions are visible only to a holder of ``runbooks:manage`` or
  ``runbooks:publish`` (a publisher must see what it approves); a runbook that has
  never been published is invisible to everyone else.
* **Transitions** (pure functions over a :class:`StoredRunbook`): edit the draft,
  discard it, submit for review, publish, reject, retire, restore, mark reviewed and
  restore an old version as a draft. Each raises :class:`CatalogError` for an
  illegal move (``409 runbook_state``) and never writes; the route runs it once as a
  pre-check (so a refusal writes no audit row, SPEC §3.6) and again inside the
  store's compare-and-set write.
* **Governance** (SPEC §4.10.5): one working version (a draft or a version in
  review) and at most one Published version at a time; editing a Published runbook
  creates a draft (D39); publishing makes the previous live version ``superseded``.
  Only a version with no validation issues can be published, so only valid, reviewed
  text ever becomes trusted investigator guidance (#9). With
  ``runbooks.require_distinct_approver`` on, the publisher must be none of the people
  who wrote the version's text (:func:`version_editors`).
* **Match preview** (:func:`match_preview`): which of the last 500 cases of the last
  30 days a definition would get, using the same pure matcher the attachment uses
  (``engine.runbook_match``). It reads cases and writes nothing (no run, no metric).
* **Metrics** (:func:`metrics`): runs started, completed and abandoned per runbook,
  median times, the most skipped steps, coverage of human-handled cases, rules seen
  with no runbook and the with/without cohorts ("comparison, not cause"), from the
  run ledger and the case store. Every figure states its population; ``partial``
  says when a figure is a lower bound.
* **Markdown** export and import (SPEC §4.10.13): an import always lands as a Draft
  (#9) and reports every problem instead of dropping it.
* The one-release **compatibility** shapes: the old runbook list and detail
  (``?shape=v1``, Published text only) and the ``410 runbooks_moved`` answer for an
  old-shape write (E14), which ``routes_case_runbooks`` reuses for the retired
  procedure routes.

Nothing here calls a model (#6), reads raw logs (#7), or feeds
``case_manager.decide()`` or ``AutoClosePolicy`` (#3): runbooks are human workflow
and advisory guidance only.
"""

from __future__ import annotations

import asyncio
import logging
import re
import statistics
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable, Literal, Mapping

from fastapi.responses import JSONResponse

from ..constants import TERMINAL_CASE_STATUSES
from ..models import (
    MatchPreview,
    MatchPreviewCase,
    MatchPreviewCounts,
    MatchPreviewNearMiss,
    MatchPreviewOther,
    RunbookDefinition,
    RunbookDetail,
    RunbookIssue,
    RunbookLibrary,
    RunbookMetrics,
    RunbookMetricsCohort,
    RunbookMetricsCohorts,
    RunbookMetricsCoverage,
    RunbookMetricsPhaseRow,
    RunbookMetricsRecentRun,
    RunbookMetricsRuleGap,
    RunbookMetricsRunbookRow,
    RunbookMetricsStepRow,
    RunbookRef,
    RunbookReviewNote,
    RunbookSummary,
    RunbookValidation,
    RunbookVersionDoc,
    RunbookVersionListItem,
)
from ..stores.runbook_library import RunbookDocumentDamaged, StoredRunbook, index_row_for
from ..stores.runbook_runs import month_of, retained_months
from ..utils import iso_now, now_utc
from .runbook_match import (
    CaseFacts,
    MatchableRunbook,
    case_facts_from_case,
    evaluate,
    is_near_miss,
    match,
    matchable_catalog,
)
from .runbook_model import (
    BUILTIN_RUNBOOK_IDS,
    ISSUE_SOURCE_SIZE,
    ISSUE_TOO_MANY,
    MAX_RUNBOOK_PROMPT_CHARS,
    VERSION_IGNORED_MESSAGE,
    BuiltinRunbook,
    applies_to,
    blocking_error_code,
    builtin_runbook,
    content_hash,
    copy_runbook_id,
    export_runbook_markdown,
    fit_id,
    is_reserved_id,
    load_builtin_runbooks,
    normalise_definition,
    parse_runbook_markdown,
    prompt_chars,
    valid_runbook_id,
    validate_runbook,
)

logger = logging.getLogger("tlsoc.engine.runbook_catalog")

# --------------------------------------------------------------------------- #
# Constants and copy (plain sentence case; never the retired word in Console copy).
# --------------------------------------------------------------------------- #
#: Who a built-in runbook's version is attributed to.
BUILTIN_AUTHOR = "Agentic SOC"
#: The match preview's population (SPEC §4.10.12): the last 500 cases of 30 days.
MATCH_PREVIEW_MAX_CASES = 500
MATCH_PREVIEW_WINDOW_DAYS = 30
#: Each match preview group lists at most this many cases (counts stay exact).
MATCH_PREVIEW_MAX_LISTED = 50
#: The metrics read at most this many cases of the window; past it every case-derived
#: figure is a lower bound and ``partial`` is set (the Round 12 exactness rule).
METRICS_MAX_CASES = 20_000
METRICS_DEFAULT_WINDOW = "now-30d"
METRICS_MAX_RULE_GAPS = 20
METRICS_MAX_STEP_ROWS = 100
METRICS_MAX_RECENT_RUNS = 10
RUNS_30D_DAYS = 30
#: A request body larger than this is refused with ``413 runbook_body_too_large``
#: before it is parsed (the route class of ``api/routes_runbooks.py`` stops reading at
#: the bound): the transport bounds of the bodies are 256 KiB of source or definition.
RUNBOOK_BODY_MAX_BYTES = 512 * 1024
#: The case scan page size for the metrics read.
_SCAN_PAGE = 1000
#: Past this many cases the metrics fold runs in a worker thread.
_FOLD_OFFLOAD_AT = 2000

RUNBOOKS_MOVED_DETAIL = "Playbooks are now runbooks."
RUNBOOKS_MOVED_SEE = "/api/runbooks"
#: The one-release compatibility headers of the old read shapes (D44, E14).
DEPRECATION_HEADERS: dict[str, str] = {
    "Deprecation": "true",
    "Link": '</api/runbooks>; rel="successor-version"',
}

ViewerOrigin = Literal["builtin", "operator", "imported"]


# --------------------------------------------------------------------------- #
# Errors.
# --------------------------------------------------------------------------- #
class CatalogError(Exception):
    """A refusal with its HTTP status, stable ``code`` and plain ``message``.

    ``extra`` is merged into the response detail (``issues`` for ``runbook_invalid``,
    ``length`` for ``runbook_prompt_budget``, ``revision`` and ``latest`` for
    ``runbook_conflict``)."""

    def __init__(self, status: int, code: str, message: str, **extra: Any) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.extra = extra

    def detail(self) -> dict[str, Any]:
        return {"code": self.code, "message": self.message, **self.extra}


def not_found(runbook_id: str = "") -> CatalogError:
    return CatalogError(404, "runbook_not_found", "This runbook does not exist or you cannot see it.")


def version_not_found(version: int) -> CatalogError:
    return CatalogError(
        404, "runbook_version_not_found",
        f"Version {version:,} of this runbook does not exist or you cannot see it.",
    )


def readonly_builtin() -> CatalogError:
    return CatalogError(
        409, "runbook_readonly",
        "Built-in runbooks are read-only. Duplicate it to make your own copy.",
    )


def state_error(message: str) -> CatalogError:
    return CatalogError(409, "runbook_state", message)


def demo_readonly() -> CatalogError:
    return CatalogError(409, "runbook_demo_readonly", "Runbooks cannot be edited in Demo Mode.")


def invalid(issues: Iterable[RunbookIssue], message: str | None = None) -> CatalogError:
    items = [i.model_dump(mode="json") for i in issues]
    count = len(items)
    text = message or (
        "Fix 1 problem and try again." if count == 1 else f"Fix {count:,} problems and try again."
    )
    return CatalogError(422, "runbook_invalid", text, issues=items)


def issues_error(issues: list[RunbookIssue], defn: RunbookDefinition | None, version: int | None) -> CatalogError:
    """The 422 a write answers for blocking ``issues`` (``blocking_error_code``)."""
    code = blocking_error_code(issues) or "runbook_invalid"
    items = [i.model_dump(mode="json") for i in issues]
    if code == "runbook_id_reserved":
        reserved = next((i for i in issues if i.path == "id"), issues[0])
        return CatalogError(422, code, reserved.message, issues=items)
    if code == "runbook_prompt_budget" and defn is not None:
        length = prompt_chars(defn, version)
        return CatalogError(
            422, code,
            f"The investigator guidance is {length:,} characters; the limit is "
            f"{MAX_RUNBOOK_PROMPT_CHARS:,}. Shorten it before publishing.",
            length=length, budget=MAX_RUNBOOK_PROMPT_CHARS, issues=items,
        )
    return invalid(issues)


def runbooks_moved_response() -> JSONResponse:
    """``410 runbooks_moved`` (SPEC §4.10.16, E14): an old-shape write cannot be
    honoured without making unreviewed text trusted (#9), so it is refused with a
    pointer to the new routes. Shared with the retired procedure routes."""
    return JSONResponse(
        status_code=410,
        content={"detail": RUNBOOKS_MOVED_DETAIL, "code": "runbooks_moved", "see": RUNBOOKS_MOVED_SEE},
        headers=dict(DEPRECATION_HEADERS),
    )


# --------------------------------------------------------------------------- #
# Small helpers.
# --------------------------------------------------------------------------- #
def _parse_ts(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        moment = value
    elif isinstance(value, str) and value.strip():
        try:
            moment = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
        except ValueError:
            return None
    else:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(timezone.utc)


def _iso(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).isoformat()


def _minutes(start: Any, end: Any) -> float | None:
    a, b = _parse_ts(start), _parse_ts(end)
    if a is None or b is None or b < a:
        return None
    return (b - a).total_seconds() / 60.0


def _median(values: list[float]) -> float | None:
    return round(float(statistics.median(values)), 1) if values else None


def _sentence_label(label: str) -> str:
    text = (label or "").strip()
    return text[:1].upper() + text[1:] if text else text


def _clip(text: Any, limit: int) -> str:
    value = "" if text is None else str(text)
    return value if len(value) <= limit else value[: max(0, limit - 1)].rstrip() + "…"


# --------------------------------------------------------------------------- #
# Views: built-ins.
# --------------------------------------------------------------------------- #
def builtin_version_doc(item: BuiltinRunbook) -> RunbookVersionDoc:
    """A built-in as the one Published version it carries (versioned by release)."""
    return RunbookVersionDoc(
        version=item.version,
        state="published",
        definition=item.definition,
        source=export_runbook_markdown(item.definition, version=item.version),
        content_hash=item.content_hash,
        author=BUILTIN_AUTHOR,
        prompt_chars=item.prompt_chars,
    )


def builtin_summary(
    item: BuiltinRunbook, *, replaced_by: str | None = None, runs_30d: int | None = None,
) -> RunbookSummary:
    defn = item.definition
    return RunbookSummary(
        id=item.id,
        title=defn.title,
        summary=defn.summary,
        origin="builtin",
        state="published",
        live_version=item.version,
        owner=defn.owner,
        phases=list(defn.phases),
        step_count=len(defn.steps),
        applies_to=applies_to(defn),
        replaced_by=replaced_by,
        runs_30d=runs_30d,
    )


def builtin_detail(item: BuiltinRunbook, *, replaced_by: str | None, runs_30d: int | None,
                   open_runs: Mapping[int, int] | None = None) -> RunbookDetail:
    doc = builtin_version_doc(item)
    return RunbookDetail(
        summary=builtin_summary(item, replaced_by=replaced_by, runs_30d=runs_30d),
        live=doc,
        versions=[RunbookVersionListItem(version=doc.version, state="published")],
        open_runs_by_version=dict(open_runs or {}),
        revision=0,
    )


# --------------------------------------------------------------------------- #
# Views: operator runbooks.
# --------------------------------------------------------------------------- #
def _visible_state(*, live: int | None, retired: bool, in_review: int | None,
                   draft: int | None) -> str | None:
    if live is not None:
        return "published"
    if retired:
        return "retired"
    if in_review is not None:
        return "in_review"
    if draft is not None:
        return "draft"
    return None


def summary_from_row(row: Any, *, can_see_unpublished: bool, runs_30d: int | None = None) -> RunbookSummary | None:
    """A library row (``stores.runbook_library.RunbookIndexRow``) as the viewer may see
    it, or ``None`` when nothing of it is visible (a never-published runbook seen
    without ``manage`` or ``publish``). The row's title and summary describe the live
    version when there is one, else the retired one, so a read-only viewer never
    reads unpublished text; nor does such a viewer learn who worked on a hidden draft
    or when (:func:`_public_touch`)."""
    draft = row.draft_version if can_see_unpublished else None
    in_review = row.in_review_version if can_see_unpublished else None
    state = _visible_state(live=row.live_version, retired=bool(row.retired), in_review=in_review, draft=draft)
    if state is None:
        return None
    updated_at, updated_by = row.updated_at, row.updated_by
    if not can_see_unpublished:
        updated_at, updated_by = _public_touch(row)
    return RunbookSummary(
        id=row.id,
        title=row.title,
        summary=row.summary,
        origin=row.origin,
        state=state,
        live_version=row.live_version,
        draft_version=draft,
        in_review_version=in_review,
        retired=bool(row.retired),
        replaces=row.replaces,
        derived_from=row.derived_from,
        owner=row.owner,
        phases=list(row.phases),
        step_count=row.step_count,
        applies_to=row.applies_to,
        runs_30d=runs_30d,
        review_due_at=row.review_due_at,
        last_reviewed_at=row.last_reviewed_at,
        last_reviewed_by=row.last_reviewed_by,
        updated_at=updated_at,
        updated_by=updated_by,
        migrated_from=row.migrated_from,
    )


def _public_touch(row: Any) -> tuple[str | None, str | None]:
    """``updated_at`` and ``updated_by`` for a viewer without ``manage`` or ``publish``:
    the later of the live version's publication and the last review, and the reviewer
    when the review is the later one (publishing records its publisher as the
    reviewer); both ``None`` when the row knows of no such change.

    The row's own ``updated_at`` and ``updated_by`` are the document's last touch,
    which a draft save, a submit, a rejection or a discard also sets. Draft activity
    is visible only to holders of ``manage`` or ``publish`` (SPEC §4.10.15), so such a
    viewer always reads the published record instead: the figure never moves when
    someone works on a hidden version, before, during or after it."""
    published = _parse_ts(row.published_at)
    reviewed = _parse_ts(row.last_reviewed_at)
    if reviewed is not None and (published is None or reviewed >= published):
        return row.last_reviewed_at, row.last_reviewed_by
    if published is not None:
        return row.published_at, None
    return None, None


def _visible_versions(doc: Any, can_see_unpublished: bool) -> list[RunbookVersionDoc]:
    return [
        v for v in doc.versions
        if can_see_unpublished or v.state not in ("draft", "in_review")
    ]


def operator_detail(
    doc: Any, revision: int, *, can_see_unpublished: bool, runs_30d: int | None,
    open_runs: Mapping[int, int] | None = None,
) -> RunbookDetail:
    """One operator runbook as the viewer may see it. Raises :func:`not_found` when
    nothing of it is visible."""
    summary = summary_from_row(index_row_for(doc, revision), can_see_unpublished=can_see_unpublished,
                               runs_30d=runs_30d)
    if summary is None:
        raise not_found(doc.id)
    versions = _visible_versions(doc, can_see_unpublished)
    return RunbookDetail(
        summary=summary,
        live=doc.live,
        draft=doc.draft if can_see_unpublished else None,
        in_review=doc.in_review if can_see_unpublished else None,
        versions=[
            RunbookVersionListItem(version=v.version, state=v.state, published_by=v.published_by,
                                   published_at=v.published_at)
            for v in sorted(versions, key=lambda v: v.version, reverse=True)
        ],
        open_runs_by_version=dict(open_runs or {}),
        revision=revision,
    )


# --------------------------------------------------------------------------- #
# The catalog snapshot (built-ins + the operator library).
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class CatalogSnapshot:
    """Every built-in and every operator library row, with which built-ins a
    Published operator copy replaces (``replaced_by``: built-in id -> copy id)."""

    builtins: tuple[BuiltinRunbook, ...]
    rows: tuple[Any, ...]
    replaced_by: dict[str, str] = field(default_factory=dict)

    def row(self, runbook_id: str) -> Any | None:
        for row in self.rows:
            if row.id == runbook_id:
                return row
        return None

    def title_of(self, runbook_id: str) -> str:
        item = builtin_runbook(runbook_id)
        if item is not None:
            return item.title
        row = self.row(runbook_id)
        return row.title if row is not None and row.title else runbook_id

    def taken_ids(self) -> set[str]:
        return {r.id for r in self.rows} | set(BUILTIN_RUNBOOK_IDS)


def _replaced_by(rows: Iterable[Any]) -> dict[str, str]:
    """A built-in stops matching once a Published operator copy replaces it (SPEC
    §4.10.5). When several do, the first by id is named."""
    out: dict[str, str] = {}
    builtin_ids = set(BUILTIN_RUNBOOK_IDS)
    for row in sorted(rows, key=lambda r: r.id):
        if row.live_version is not None and row.replaces in builtin_ids:
            out.setdefault(row.replaces, row.id)
    return out


async def snapshot(library: Any) -> CatalogSnapshot:
    rows = tuple(await library.list_rows())
    return CatalogSnapshot(builtins=load_builtin_runbooks(), rows=rows, replaced_by=_replaced_by(rows))


async def stored_revision(library: Any, runbook_id: str) -> int:
    """The revision the runbook document of ``runbook_id`` holds now, ``0`` when none
    was ever written. A discarded runbook leaves a tombstone, so a new runbook of that
    id is written at the tombstone's revision plus one, not at 1: the create's audit
    row names that revision (SPEC §3.6). A read failure is
    ``RunbookStoreUnavailable`` (``503``), and nothing is audited."""
    from ..constants import RUNBOOK_LIBRARY_NS
    from ..stores.runbook_library import REV_FIELD, RunbookStoreUnavailable, doc_key

    kv = getattr(library, "kv", None)
    if kv is None:
        return 0
    getter = getattr(kv, "get_strict", None)
    try:
        raw = (await getter(RUNBOOK_LIBRARY_NS, doc_key(runbook_id)) if callable(getter)
               else await kv.get(RUNBOOK_LIBRARY_NS, doc_key(runbook_id)))
    except Exception as exc:  # noqa: BLE001 - every read failure means "unknown"
        raise RunbookStoreUnavailable("The runbook library could not be read.") from exc
    if not isinstance(raw, Mapping):
        return 0
    try:
        return max(0, int(raw.get(REV_FIELD, 0) or 0))
    except (TypeError, ValueError):
        return 0


async def matchable(library: Any, *, overlay: MatchableRunbook | None = None,
                    overlay_replaces: str | None = None) -> tuple[MatchableRunbook, ...]:
    """The matcher's catalog (``runbook_match.matchable_catalog``): every built-in not
    replaced by a Published operator copy and every Published operator runbook; never a
    draft, a version in review or a retired runbook.

    ``overlay`` substitutes one runbook as if it were Published now (the match
    preview): it takes the place of any runbook with its id, and ``overlay_replaces``
    names the built-in it would replace."""
    published = await library.published_catalog()
    builtins = [
        MatchableRunbook(id=b.id, version=b.version, definition=b.definition, origin="builtin")
        for b in load_builtin_runbooks()
    ]
    operators = [
        MatchableRunbook(id=p.runbook.id, version=p.live.version, definition=p.live.definition,
                         origin=p.runbook.origin, published_at=p.live.published_at)
        for p in published
    ]
    replaced = {p.runbook.replaces for p in published if p.runbook.replaces}
    if overlay is not None:
        builtins = [b for b in builtins if b.id != overlay.id]
        operators = [o for o in operators if o.id != overlay.id]
        replaced.discard(overlay.id)
        if overlay_replaces:
            replaced.add(overlay_replaces)
        operators.append(overlay)
    return matchable_catalog(builtins, operators, replaced_builtin_ids=replaced)


# --------------------------------------------------------------------------- #
# Library list.
# --------------------------------------------------------------------------- #
def _matches_query(summary: RunbookSummary, query: str) -> bool:
    if not query:
        return True
    haystack = " ".join([
        summary.id, summary.title, summary.summary, summary.owner or "",
        *summary.applies_to.rule_ids, *summary.applies_to.mitre,
    ]).casefold()
    return all(term in haystack for term in query.casefold().split())


def _matches_state(summary: RunbookSummary, wanted: str | None) -> bool:
    if not wanted:
        return True
    if wanted == "draft":
        return summary.draft_version is not None
    if wanted == "in_review":
        return summary.in_review_version is not None
    if wanted == "published":
        return summary.live_version is not None
    if wanted == "retired":
        return summary.retired
    return False


def library(
    snap: CatalogSnapshot,
    *,
    can_see_unpublished: bool,
    runs_30d: Mapping[str, int] | None,
    q: str = "",
    state: str | None = None,
    origin: str | None = None,
    show_replaced: bool = False,
    migration: Any = None,
) -> RunbookLibrary:
    """``GET /api/runbooks`` (the new shape). Built-ins are always listed (there is no
    empty library) except those a Published copy replaces, which appear only with
    ``show_replaced``. ``runs_30d`` is ``None`` when the viewer cannot read cases."""
    out: list[RunbookSummary] = []

    def _runs(runbook_id: str) -> int | None:
        return None if runs_30d is None else int(runs_30d.get(runbook_id, 0))

    for item in snap.builtins:
        replaced_by = snap.replaced_by.get(item.id)
        if replaced_by and not show_replaced:
            continue
        out.append(builtin_summary(item, replaced_by=replaced_by, runs_30d=_runs(item.id)))
    for row in snap.rows:
        if row.id in BUILTIN_RUNBOOK_IDS:
            continue  # a built-in always wins an id collision; never listed twice
        summary = summary_from_row(row, can_see_unpublished=can_see_unpublished, runs_30d=_runs(row.id))
        if summary is not None:
            out.append(summary)
    query = (q or "").strip()
    picked = [
        s for s in out
        if _matches_query(s, query) and _matches_state(s, state) and (not origin or s.origin == origin)
    ]
    picked.sort(key=lambda s: (s.title.casefold(), s.id))
    return RunbookLibrary(runbooks=picked, migration=migration)


# --------------------------------------------------------------------------- #
# Definitions from a request body.
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class BodyDefinition:
    """A definition read from ``{definition}`` or ``{source}``: the definition, the
    parser's own issues (unknown keys, malformed values), whether it came from source,
    and the front matter version (ignored by every write)."""

    definition: RunbookDefinition
    parse_issues: tuple[RunbookIssue, ...] = ()
    from_source: bool = False
    version: int | None = None


def _one_of(definition: Any, source: Any) -> None:
    if definition is not None and source is not None:
        raise invalid([RunbookIssue(path="source", code="invalid",
                                    message="Send either a definition or Markdown source, not both.")])
    if definition is None and source is None:
        raise invalid([RunbookIssue(path="source", code="required",
                                    message="Send a definition or Markdown source.")])


def definition_from_body(definition: RunbookDefinition | None, source: str | None) -> BodyDefinition:
    """The definition a body carries. Markdown that cannot be turned into a definition
    is ``422 runbook_invalid`` with the parser's issues (nothing is stored)."""
    _one_of(definition, source)
    if definition is not None:
        return BodyDefinition(definition=definition)
    parsed = parse_runbook_markdown(str(source))
    if parsed.definition is None:
        raise invalid(list(parsed.issues) or [RunbookIssue(
            path="source", code="parse", message="The Markdown could not be read as a runbook.",
        )])
    return BodyDefinition(definition=parsed.definition, parse_issues=tuple(parsed.issues),
                          from_source=True, version=parsed.version)


def _informational(issue: RunbookIssue) -> bool:
    """A parser note that never stops a write: the front matter ``version``, which
    every write ignores (the server numbers versions), so its "ignored" note informs
    and refuses nothing."""
    return issue.path == "version" and issue.message == VERSION_IGNORED_MESSAGE


def blocking_parse_issues(parsed: BodyDefinition) -> list[RunbookIssue]:
    """The parser issues that refuse a create or a draft save (``422 runbook_invalid``):
    every issue except the informational ones (:func:`_informational`). An unknown key
    or a malformed value still refuses, so nothing in the source is silently dropped."""
    return [i for i in parsed.parse_issues if not _informational(i)]


def with_review_default(defn: RunbookDefinition, default_days: int) -> RunbookDefinition:
    """A new operator runbook takes the configured review cadence (E6) unless its
    definition states one."""
    if "review_every_days" in defn.model_fields_set:
        return defn
    return defn.model_copy(update={"review_every_days": int(default_days)})


def with_review_carried(defn: RunbookDefinition, doc: Any, default_days: int) -> RunbookDefinition:
    """A saved draft that does not state its review cadence keeps the one the runbook
    already has (its working version's, else the live or retired one's), and only a
    runbook with none takes the configured default: leaving the field out of an edit
    never resets the cadence to the model's 180 days."""
    if "review_every_days" in defn.model_fields_set:
        return defn
    current = working_version(doc) or doc.live or doc.retired_version
    days = current.definition.review_every_days if current is not None else default_days
    return defn.model_copy(update={"review_every_days": int(days)})


def validation_origin(defn: RunbookDefinition) -> ViewerOrigin:
    """The origin a definition is checked as: ``builtin`` for a built-in's own bundled
    text (its Source and Preview are checked as what they are, so the read-only view
    never reports the built-in's id as taken), else ``operator``. A built-in's id with
    any other text is an operator runbook claiming a taken id, and is reported."""
    item = builtin_runbook(defn.id)
    if item is not None and content_hash(normalise_definition(defn)) == item.content_hash:
        return "builtin"
    return "operator"


def draft_blocking_issues(defn: RunbookDefinition, *, origin: str) -> list[RunbookIssue]:
    """The issues that stop a DRAFT from being stored: its identity (a missing,
    reserved, built-in or malformed id), its size and the 40-step limit (SPEC
    §4.10.5). Every other content problem is allowed in a draft (the editor lists it)
    and blocks only submit and publish."""
    issues = validate_runbook(defn, origin=origin, check_prompt_budget=False)
    return [
        i for i in issues
        if i.path == "id" or i.code == ISSUE_SOURCE_SIZE or (i.path == "steps" and i.code == ISSUE_TOO_MANY)
    ]


def validation(defn: RunbookDefinition, parse_issues: Iterable[RunbookIssue] = (),
               *, origin: str = "operator", version: int | None = None) -> RunbookValidation:
    """``POST /api/runbooks/validate``: every issue (the parser's first) and the
    investigator guidance length against its budget. Nothing is written."""
    issues = [*parse_issues, *validate_runbook(defn, origin=origin, version=version)]
    return RunbookValidation(issues=issues, prompt_chars=prompt_chars(defn, version),
                             prompt_budget=MAX_RUNBOOK_PROMPT_CHARS)


def publishable_issues(defn: RunbookDefinition, *, origin: str, version: int) -> list[RunbookIssue]:
    return validate_runbook(defn, origin=origin, version=version)


# --------------------------------------------------------------------------- #
# Version documents.
# --------------------------------------------------------------------------- #
def new_version(defn: RunbookDefinition, *, number: int, state: str, author: str, now: str,
                import_notes: Iterable[str] = ()) -> RunbookVersionDoc:
    """A stored version of ``defn`` in its canonical form: the normalised definition,
    its Markdown export, its content hash and its guidance length."""
    canonical = normalise_definition(defn)
    return RunbookVersionDoc(
        version=number,
        state=state,  # type: ignore[arg-type]
        definition=canonical,
        source=export_runbook_markdown(canonical, version=number),
        content_hash=content_hash(canonical),
        author=author,
        created_at=now,
        import_notes=list(import_notes),
        prompt_chars=prompt_chars(canonical, number),
    )


def _replace_version(doc: Any, number: int, new: RunbookVersionDoc | None) -> list[RunbookVersionDoc]:
    out = [v for v in doc.versions if v.version != number]
    if new is not None:
        out.append(new)
    return sorted(out, key=lambda v: v.version)


def working_version(doc: Any) -> RunbookVersionDoc | None:
    """The version being written or reviewed (a draft, else one in review)."""
    return doc.draft or doc.in_review


def stored_hash(version: RunbookVersionDoc) -> str:
    return version.content_hash or content_hash(version.definition)


# --------------------------------------------------------------------------- #
# Who wrote a version (separation of duties, D35).
# --------------------------------------------------------------------------- #
#: The stored runbook's record of every person who saved each version's text, as
#: ``{"<version>": [username, ...]}`` in first-save order. ``StoredRunbook`` keeps
#: fields it does not declare, so this is additive: a document written before it
#: existed (or by the migration) falls back to the version's ``author``.
EDITORS_FIELD = "version_editors"


def version_editors(doc: Any, number: int) -> tuple[str, ...]:
    """Everyone who wrote version ``number``'s text: each person who saved it, and its
    ``author`` (the last one). With ``runbooks.require_distinct_approver`` on, none of
    them may publish it (D35): a one-word edit by a second person never lets the first
    writer approve their own text, and the second writer cannot approve it either."""
    names: list[str] = []
    raw = (getattr(doc, "model_extra", None) or {}).get(EDITORS_FIELD)
    if isinstance(raw, Mapping):
        listed = raw.get(str(int(number)))
        if isinstance(listed, list):
            names = [n for n in listed if isinstance(n, str) and n]
    version = doc.version(int(number))
    if version is not None and version.author:
        names.append(version.author)
    return tuple(dict.fromkeys(names))


def with_editors(doc: Any, number: int, names: Iterable[str]) -> Any:
    """``doc`` with version ``number``'s writers set to ``names`` (blank names, such as
    the anonymous caller of the no-auth profile, are not recorded). Entries of versions
    the document no longer holds are dropped."""
    raw = (getattr(doc, "model_extra", None) or {}).get(EDITORS_FIELD)
    held = {str(v.version) for v in doc.versions}
    out: dict[str, list[str]] = {}
    if isinstance(raw, Mapping):
        for key, listed in raw.items():
            if key in held and isinstance(listed, list):
                kept = [n for n in listed if isinstance(n, str) and n]
                if kept:
                    out[str(key)] = kept
    cleaned = list(dict.fromkeys(n for n in names if isinstance(n, str) and n))
    if cleaned and str(int(number)) in held:
        out[str(int(number))] = cleaned
    else:
        out.pop(str(int(number)), None)
    return doc.model_copy(update={EDITORS_FIELD: out})


# --------------------------------------------------------------------------- #
# Transitions (pure; never write).
# --------------------------------------------------------------------------- #
def _touch(doc: Any, actor: str, now: str) -> dict[str, Any]:
    return {"updated_by": actor, "updated_at": now}


def t_save_draft(doc: Any, defn: RunbookDefinition, *, actor: str, now: str) -> Any:
    """Edit the working version in place (a version in review goes back to draft:
    editing withdraws it from review), or create the next version as a draft when
    there is none (editing a Published runbook creates a draft, D39). The saver joins
    the version's writers (:func:`version_editors`); a new draft's only writer is the
    saver, because the live text it starts from was already approved."""
    if defn.id != doc.id:
        raise invalid([RunbookIssue(path="id", code="invalid",
                                    message=f"The id cannot change. Keep '{doc.id}'.")])
    working = working_version(doc)
    if working is not None:
        number = working.version
        notes = list(working.import_notes)
        review_notes = list(working.review_notes)
        editors = [*version_editors(doc, number), actor]
    else:
        number = doc.next_version_number()
        notes, review_notes = [], []
        editors = [actor]
    version = new_version(defn, number=number, state="draft", author=actor, now=now, import_notes=notes)
    version = version.model_copy(update={"review_notes": review_notes})
    updated = doc.model_copy(update={"versions": _replace_version(doc, number, version), **_touch(doc, actor, now)})
    return with_editors(updated, number, editors)


def unchanged_save(doc: Any, defn: RunbookDefinition) -> bool:
    """True when saving ``defn`` would change no text: it equals the working version
    (a draft or a version in review), or, when there is none, the live version. Such a
    save (an autosave, a Save pressed twice) writes nothing and records nothing; in
    particular it never takes a version out of review or opens an identical draft."""
    current = working_version(doc) or doc.live
    return current is not None and stored_hash(current) == content_hash(normalise_definition(defn))


def t_discard_draft(doc: Any, *, actor: str, now: str) -> tuple[Any | None, RunbookVersionDoc]:
    """Remove the working version. Returns ``(new document, removed version)``; the new
    document is ``None`` when nothing else is left (a never-published runbook
    disappears). Published history is never deleted."""
    working = working_version(doc)
    if working is None:
        raise state_error("There is no draft to discard.")
    remaining = [v for v in doc.versions if v.version != working.version]
    if not remaining:
        return None, working
    left = doc.model_copy(update={"versions": remaining, **_touch(doc, actor, now)})
    return with_editors(left, working.version, ()), working


def _require_version(doc: Any, number: int) -> RunbookVersionDoc:
    version = doc.version(int(number))
    if version is None:
        raise version_not_found(int(number))
    return version


def t_submit(doc: Any, number: int, *, actor: str, now: str) -> Any:
    """A valid draft goes to review."""
    version = _require_version(doc, number)
    if version.state != "draft":
        raise state_error(f"Only a draft can be sent for review; version {number:,} is "
                          f"{_STATE_WORDS[version.state]}.")
    if doc.in_review is not None:
        raise state_error(f"Version {doc.in_review.version:,} is already in review.")
    issues = publishable_issues(version.definition, origin=doc.origin, version=number)
    if issues:
        raise issues_error(issues, version.definition, number)
    updated = version.model_copy(update={"state": "in_review", "submitted_by": actor, "submitted_at": now})
    return doc.model_copy(update={"versions": _replace_version(doc, number, updated), **_touch(doc, actor, now)})


_STATE_WORDS = {
    "draft": "a draft", "in_review": "in review", "published": "published",
    "superseded": "an earlier version", "retired": "retired",
}


def t_publish(doc: Any, number: int, *, actor: str, now: str, expected_hash: str | None,
              require_distinct_approver: bool) -> Any:
    """Make a draft or in-review version the live one (``runbooks:publish``).

    Refused when the version is not a draft or in review (``runbook_state``), when
    ``expected_hash`` names other text than the stored version (``runbook_conflict``),
    when a second approver is required and the publisher wrote any of the version
    (``runbook_distinct_approver``, :func:`version_editors`), and when the version has
    any validation issue (``runbook_invalid``, ``runbook_prompt_budget``): only valid,
    reviewed text is ever trusted (#9). The previous live version becomes
    ``superseded``; a retired one is superseded too (publishing un-retires the
    runbook). Publishing counts as a review: the next review falls due
    ``review_every_days`` from now."""
    version = _require_version(doc, number)
    if version.state not in ("draft", "in_review"):
        raise state_error(f"Version {number:,} is {_STATE_WORDS[version.state]}, so it cannot be published.")
    if expected_hash is not None and expected_hash != stored_hash(version):
        raise CatalogError(409, "runbook_conflict",
                           "This version changed after you reviewed it. Reload it and review it again.")
    if require_distinct_approver:
        if not actor:
            raise CatalogError(403, "runbook_distinct_approver",
                               "Publishing needs a second person, and this request is not signed in.")
        if actor in version_editors(doc, number):
            raise CatalogError(403, "runbook_distinct_approver",
                               "You wrote or edited this version, so another person with publish rights "
                               "must publish it.")
    issues = publishable_issues(version.definition, origin=doc.origin, version=number)
    if issues:
        raise issues_error(issues, version.definition, number)
    stamp = _parse_ts(now) or now_utc()
    versions: list[RunbookVersionDoc] = []
    for item in doc.versions:
        if item.version == number:
            item = item.model_copy(update={
                "state": "published", "published_by": actor, "published_at": now,
                "prompt_chars": prompt_chars(item.definition, number),
                "content_hash": stored_hash(item),
            })
        elif item.state in ("published", "retired"):
            item = item.model_copy(update={"state": "superseded", "superseded_at": now})
        versions.append(item)
    due = stamp + timedelta(days=int(version.definition.review_every_days))
    return doc.model_copy(update={
        "versions": versions,
        "last_reviewed_at": now,
        "last_reviewed_by": actor,
        "review_due_at": _iso(due),
        **_touch(doc, actor, now),
    })


def t_reject(doc: Any, number: int, reason: str, *, actor: str, now: str) -> Any:
    """A version in review goes back to draft with the reviewer's reason (required:
    a blank one tells the author nothing, ``422 runbook_invalid``)."""
    text = (reason or "").strip()
    if not text:
        raise invalid([RunbookIssue(path="reason", code="required",
                                    message="Give a reason so the author knows what to change.")])
    version = _require_version(doc, number)
    if version.state != "in_review":
        raise state_error(f"Only a version in review can be sent back; version {number:,} is "
                          f"{_STATE_WORDS[version.state]}.")
    note = RunbookReviewNote(by=actor, at=now, text=text)
    updated = version.model_copy(update={
        "state": "draft", "review_notes": [*version.review_notes, note],
    })
    return doc.model_copy(update={"versions": _replace_version(doc, number, updated), **_touch(doc, actor, now)})


def t_retire(doc: Any, *, actor: str, now: str) -> Any:
    """The live version is retired: the runbook stops matching; runs keep working."""
    live = doc.live
    if live is None:
        raise state_error("Only a published runbook can be retired.")
    updated = live.model_copy(update={"state": "retired", "retired_by": actor, "retired_at": now})
    return doc.model_copy(update={"versions": _replace_version(doc, live.version, updated), **_touch(doc, actor, now)})


def t_restore(doc: Any, *, actor: str, now: str) -> Any:
    """The retired version is live again (``runbooks:publish``). It is checked again
    first: only valid text is ever made live."""
    retired = doc.retired_version
    if retired is None or doc.live is not None:
        raise state_error("Only a retired runbook can be restored.")
    issues = publishable_issues(retired.definition, origin=doc.origin, version=retired.version)
    if issues:
        raise issues_error(issues, retired.definition, retired.version)
    updated = retired.model_copy(update={"state": "published", "retired_by": None, "retired_at": None})
    return doc.model_copy(update={"versions": _replace_version(doc, retired.version, updated), **_touch(doc, actor, now)})


def t_reviewed(doc: Any, *, actor: str, now: str) -> Any:
    """Mark reviewed: records the reviewer and time without a new version."""
    live = doc.live
    if live is None:
        raise state_error("Only a published runbook can be marked reviewed.")
    stamp = _parse_ts(now) or now_utc()
    due = stamp + timedelta(days=int(live.definition.review_every_days))
    return doc.model_copy(update={
        "last_reviewed_at": now, "last_reviewed_by": actor, "review_due_at": _iso(due),
        **_touch(doc, actor, now),
    })


def t_restore_version(doc: Any, number: int, *, actor: str, now: str) -> Any:
    """A new draft from version ``number`` (any state). Refused while another draft or
    a version in review exists, so nobody's work is overwritten."""
    source = _require_version(doc, number)
    working = working_version(doc)
    if working is not None:
        raise state_error(f"Version {working.version:,} is still {_STATE_WORDS[working.state]}. "
                          "Discard or publish it first.")
    created = new_version(source.definition, number=doc.next_version_number(), state="draft",
                          author=actor, now=now)
    updated = doc.model_copy(update={"versions": _replace_version(doc, created.version, created),
                                     **_touch(doc, actor, now)})
    # The restored text was published once, so it was approved; the restorer is its
    # only new writer.
    return with_editors(updated, created.version, [actor])


def new_operator_runbook(defn: RunbookDefinition, *, actor: str, now: str, origin: str = "operator",
                         replaces: str | None = None, derived_from: RunbookRef | None = None,
                         import_notes: Iterable[str] = (), editors: Iterable[str] = (),
                         review_due_at: str | None = None) -> Any:
    """A new library document holding ``defn`` as its version 1 draft, written by
    ``actor`` and ``editors`` (the writers of unapproved text it copies).
    ``review_due_at`` is set for imported content, which is due at once (D38)."""
    version = new_version(defn, number=1, state="draft", author=actor, now=now, import_notes=import_notes)
    doc = StoredRunbook(
        id=version.definition.id,
        origin=origin,  # type: ignore[arg-type]
        versions=[version],
        replaces=replaces,
        derived_from=derived_from,
        review_due_at=review_due_at,
        created_at=now,
        created_by=actor,
        updated_at=now,
        updated_by=actor,
    )
    return with_editors(doc, 1, [*editors, actor])


# --------------------------------------------------------------------------- #
# Duplicate and import.
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class CopyPlan:
    definition: RunbookDefinition
    derived_from: RunbookRef
    replaces: str | None
    #: The writers of the copied text when it was never approved (a draft or a version
    #: in review): they stay its writers in the copy, so copying a draft never lets its
    #: own writer publish it alone (D35).
    editors: tuple[str, ...] = ()


def duplicate_plan(source_id: str, source_doc: Any | None, taken: set[str]) -> CopyPlan:
    """The copy "Duplicate to customise" makes: a built-in's copy is ``<id>-custom``
    and replaces the built-in once Published; an operator runbook's copy is
    ``<id>-custom`` too, titled "(copy)", and replaces nothing. The copy is of the
    live version, else the working version, else the retired one."""
    item = builtin_runbook(source_id)
    if item is not None:
        new_id = copy_runbook_id(item.id, taken)
        defn = item.definition.model_copy(update={"id": new_id})
        return CopyPlan(defn, RunbookRef(id=item.id, version=item.version), item.id)
    if source_doc is None:
        raise not_found(source_id)
    version = source_doc.live or working_version(source_doc) or source_doc.retired_version
    if version is None:  # pragma: no cover - a stored runbook always has a version
        raise not_found(source_id)
    new_id = copy_runbook_id(source_doc.id, taken)
    title = version.definition.title
    copy_title = f"{title} (copy)"
    defn = version.definition.model_copy(update={
        "id": new_id, "title": copy_title if len(copy_title) <= 120 else title,
    })
    unapproved = version.state in ("draft", "in_review")
    return CopyPlan(defn, RunbookRef(id=source_doc.id, version=version.version), None,
                    editors=version_editors(source_doc, version.version) if unapproved else ())


def _unique_suffixed(base: str, suffix: str, taken: set[str]) -> str:
    candidate, n = fit_id(base, suffix), 2
    while candidate in taken or is_reserved_id(candidate):
        candidate = fit_id(base, f"{suffix}-{n}")
        n += 1
    return candidate


@dataclass(frozen=True)
class ImportPlan:
    definition: RunbookDefinition
    replaces: str | None
    notes: tuple[str, ...]


def import_plan(source: str, taken: set[str], *, review_default: int) -> ImportPlan:
    """What ``POST /api/runbooks/import`` stores (SPEC §4.10.13): always a new Draft,
    never published (#9). The front matter ``version`` is ignored. An id that is
    reserved, that a built-in holds or that the library already holds is renamed
    (a built-in's copy records that it replaces the built-in), and every parse and
    content problem is kept as an import note instead of being dropped. Markdown that
    cannot be read as a runbook, or whose id is malformed, is ``422 runbook_invalid``."""
    parsed = parse_runbook_markdown(source)
    if parsed.definition is None:
        raise invalid(list(parsed.issues) or [RunbookIssue(
            path="source", code="parse", message="The Markdown could not be read as a runbook.",
        )])
    defn = with_review_default(parsed.definition, review_default)
    notes: list[str] = []
    replaces: str | None = None
    rid = defn.id
    if is_reserved_id(rid):
        rid = _unique_suffixed(rid, "-imported", taken)
        notes.append(f"Renamed to '{rid}' because the id '{defn.id}' is reserved.")
    elif rid in BUILTIN_RUNBOOK_IDS:
        replaces = rid
        rid = copy_runbook_id(rid, taken)
        notes.append(f"Renamed to '{rid}' because a built-in runbook has the id '{defn.id}'. "
                     "Publishing it replaces that built-in.")
    elif rid in taken:
        rid = _unique_suffixed(rid, "-imported", taken)
        notes.append(f"Renamed to '{rid}' because a runbook with the id '{defn.id}' already exists.")
    elif not valid_runbook_id(rid, "operator"):
        raise invalid(draft_blocking_issues(defn, origin="imported") or [RunbookIssue(
            path="id", code="invalid", message="The id is not valid.",
        )])
    if rid != defn.id:
        defn = defn.model_copy(update={"id": rid})
    blocking = draft_blocking_issues(defn, origin="imported")
    if blocking:
        raise issues_error(blocking, defn, None)
    notes += [i.message for i in parsed.issues]
    notes += [i.message for i in validate_runbook(defn, origin="imported")]
    return ImportPlan(defn, replaces, tuple(dict.fromkeys(notes)))


# --------------------------------------------------------------------------- #
# Export.
# --------------------------------------------------------------------------- #
def export_file_name(runbook_id: str, version: int) -> str:
    safe = re.sub(r"[^a-z0-9_-]", "-", runbook_id.lower())[:64] or "runbook"
    return f"{safe}-v{int(version)}.md"


def export_markdown(version: RunbookVersionDoc) -> str:
    """The native Markdown form of one version (SPEC §4.10.13), with its version."""
    return export_runbook_markdown(version.definition, version=version.version)


# --------------------------------------------------------------------------- #
# The run ledger: runs in the last 30 days, open runs per version.
# --------------------------------------------------------------------------- #
async def _ledger_rows(runs_store: Any, months: Iterable[str] | None = None) -> tuple[list[Any], bool]:
    """Every ledger row of the retained months (or ``months``), and whether any month
    reached its cap (rows missing, so counts are lower bounds)."""
    rows, capped = await _ledger_months(runs_store, months)
    return rows, bool(capped)


async def _ledger_months(runs_store: Any, months: Iterable[str] | None = None) -> tuple[list[Any], set[str]]:
    """Every ledger row of the retained months (or ``months``), and the months that
    reached their cap (``yyyy-mm``). Each month is its own document, so the months are
    read at once (at most the 13 retained), oldest first."""
    wanted = sorted(set(months if months is not None else retained_months()))
    if not wanted:
        return [], set()
    parts = await asyncio.gather(*(runs_store.read_ledger([month]) for month in wanted))
    rows: list[Any] = []
    capped: set[str] = set()
    for part in parts:
        for month in part:
            rows.extend(month.rows)
            if month.partial:
                capped.add(month.month)
    return rows, capped


def _months_between(start: datetime | None, end: datetime) -> set[str]:
    """The ``yyyy-mm`` months a ``[start, end)`` window touches, within the retained
    ledger months (an open start reaches back to the oldest one)."""
    kept = retained_months()
    first = month_of(_iso(start)) if start is not None else min(kept)
    last = month_of(_iso(end))
    return {m for m in kept if first <= m <= last}


async def ledger_rows(runs_store: Any) -> list[Any]:
    """Every ledger row of the retained months, read once so one request can derive
    several figures from it (a runbook's detail needs both its runs of the last 30 days
    and its open runs per version)."""
    rows, _partial = await _ledger_rows(runs_store)
    return rows


async def runs_started_since(runs_store: Any, since: datetime, *, rows: list[Any] | None = None) -> dict[str, int]:
    """Runs started at or after ``since``, per runbook id (the library's "Runs (30
    days)" column). ``rows`` is a ledger read the caller already holds
    (:func:`ledger_rows`); without it only the months from ``since`` are read."""
    if rows is None:
        first = month_of(_iso(since))
        months = [m for m in retained_months() if m >= first]
        rows, _partial = await _ledger_rows(runs_store, months)
    out: dict[str, int] = {}
    for row in rows:
        started = _parse_ts(row.started_at)
        if started is not None and started >= since:
            out[row.runbook_id] = out.get(row.runbook_id, 0) + 1
    return out


async def open_runs_by_version(runs_store: Any, runbook_id: str, *, rows: list[Any] | None = None) -> dict[int, int]:
    """Active runs pinned to each version of one runbook ("3 open cases stay on v4").
    An active run can have started in any retained month, so every one is read unless
    the caller passes the ``rows`` it already holds (:func:`ledger_rows`)."""
    if rows is None:
        rows = await ledger_rows(runs_store)
    out: dict[int, int] = {}
    for row in rows:
        if row.runbook_id == runbook_id and row.status == "active":
            out[int(row.version)] = out.get(int(row.version), 0) + 1
    return dict(sorted(out.items()))


# --------------------------------------------------------------------------- #
# Cases (read-only).
# --------------------------------------------------------------------------- #
def _as_case(row: Any) -> Any | None:
    if isinstance(row, dict):
        from ..models import Case

        try:
            return Case.model_validate(row)
        except Exception:  # noqa: BLE001 - one damaged document never fails a read
            return None
    return row


def source_types_of(prefs: Any) -> dict[str, str]:
    """Each configured source id to its ``SourceType`` value (``type:`` criteria)."""
    out: dict[str, str] = {}
    for source in getattr(prefs, "sources", None) or []:
        sid = getattr(source, "id", None)
        stype = getattr(source, "source_type", None)
        value = getattr(stype, "value", stype)
        if isinstance(sid, str) and isinstance(value, str):
            out[sid] = value
    return out


async def recent_cases(cases_store: Any, *, days: int, limit: int) -> list[Any]:
    """The newest ``limit`` cases created in the last ``days`` days, newest first."""
    since = _iso(now_utc() - timedelta(days=days))
    rows, _total, _exact = await cases_store.list_window(
        created_from=since, limit=limit, sort_field="created_at", sort_order="desc",
    )
    out = []
    for row in rows:
        case = _as_case(row)
        if case is not None:
            out.append(case)
    return out


async def cases_in_window(cases_store: Any, start: datetime | None, end: datetime,
                          *, cap: int = METRICS_MAX_CASES) -> tuple[list[Any], bool]:
    """Every case created in ``[start, end)`` (at most ``cap``) and whether the read
    stopped at the cap. A case whose creation time cannot be placed is left out (it
    cannot be said to fall in any window)."""
    out: list[Any] = []
    cursor: Any = None
    started = False
    truncated = False
    try:
        while not started or cursor is not None:
            started = True
            rows, cursor, _total, _consistency = await cases_store.scan_page(
                limit=_SCAN_PAGE, cursor=cursor, created_from=start, created_to=end,
            )
            for row in rows:
                case = _as_case(row)
                if case is None:
                    continue
                created = _parse_ts(getattr(case, "created_at", None))
                if created is None or created >= end or (start is not None and created < start):
                    continue
                if len(out) >= cap:
                    truncated = True
                    break
                out.append(case)
            if truncated:
                break
    finally:
        if truncated and cursor is not None:
            closer = getattr(cases_store, "close_export_cursor", None)
            if callable(closer):
                try:
                    await closer(cursor)
                except Exception:  # noqa: BLE001 - releasing a scan is best-effort
                    pass
    return out, truncated


def _status(case: Any) -> str:
    raw = getattr(case, "status", None)
    return str(getattr(raw, "value", raw) or "")


def _decided_by(case: Any) -> str:
    raw = getattr(case, "decision_by", None)
    return str(getattr(raw, "value", raw) or "")


def human_handled(case: Any) -> bool:
    """A case that needed a person: still open (automatic closes are terminal at once,
    even inside their objection window), or closed by an analyst. Cases the agent or
    an analyst policy closed are not human-handled."""
    if _status(case) not in TERMINAL_CASE_STATUSES:
        return True
    return _decided_by(case) == "analyst"


def _primary_rule(facts: CaseFacts) -> str | None:
    return facts.rule_values[0] if facts.rule_values else None


# --------------------------------------------------------------------------- #
# Match preview.
# --------------------------------------------------------------------------- #
def _preview_near_miss(evaluation: Any) -> bool:
    """A near miss for the editor: the matcher's rule (at least one criterion matched,
    exactly one failed, ``runbook_match.is_near_miss``), except when the one that
    failed is the rule list. A case from another detection is not "almost" this
    runbook's case; counting every such case would bury the useful near misses (a
    rule that matched with the wrong entity type or severity) under unrelated ones."""
    if not is_near_miss(evaluation):
        return False
    return all(item.criterion != "rule_ids" for item in evaluation.missed)


async def match_preview(
    *,
    library_store: Any,
    cases_store: Any,
    prefs: Any,
    definition: RunbookDefinition,
    origin: ViewerOrigin,
    replaces: str | None,
    fallback: bool,
) -> MatchPreview:
    """Which of the last 500 cases of 30 days ``definition`` would get if it were
    Published now (SPEC §4.10.12): "Gets it" (it would win), "Another wins" (it
    matches but another runbook ranks higher, named) and "Near misses" (one criterion
    failed). Pure read: nothing is attached and no metric changes."""
    overlay = MatchableRunbook(id=definition.id, version=1, definition=definition,
                               origin=origin, published_at=iso_now())
    catalog = await matchable(library_store, overlay=overlay, overlay_replaces=replaces)
    cases = await recent_cases(cases_store, days=MATCH_PREVIEW_WINDOW_DAYS, limit=MATCH_PREVIEW_MAX_CASES)
    mapping = source_types_of(prefs)
    titles = {item.id: item.title for item in catalog}
    gets: list[MatchPreviewCase] = []
    others: list[MatchPreviewOther] = []
    near: list[MatchPreviewNearMiss] = []
    counts = MatchPreviewCounts()
    for case in cases:
        facts = case_facts_from_case(case, prefs=prefs, source_types=mapping)
        result = match(facts, catalog, fallback=fallback)
        own = evaluate(facts, definition)
        case_id = str(getattr(case, "case_id", ""))
        number = str(getattr(case, "case_number", "") or "")
        title = _clip(getattr(case, "title", "") or getattr(case, "summary", "") or "", 200)
        if result.winner is not None and result.winner.id == definition.id:
            counts.gets_it += 1
            if len(gets) < MATCH_PREVIEW_MAX_LISTED:
                gets.append(MatchPreviewCase(case_id=case_id, case_number=number, title=title,
                                             explanation=result.explanation))
        elif own.matches and not (definition.applies_when.always and not fallback):
            counts.another_wins += 1
            if len(others) < MATCH_PREVIEW_MAX_LISTED and result.winner is not None:
                others.append(MatchPreviewOther(case_id=case_id, case_number=number, title=title,
                                                winner_id=result.winner.id,
                                                winner_title=titles.get(result.winner.id, result.winner.id)))
        elif _preview_near_miss(own):
            counts.near_misses += 1
            if len(near) < MATCH_PREVIEW_MAX_LISTED:
                near.append(MatchPreviewNearMiss(case_id=case_id, case_number=number, title=title,
                                                 failed=list(own.missed)))
    truncated = (counts.gets_it > len(gets) or counts.another_wins > len(others)
                 or counts.near_misses > len(near))
    return MatchPreview(
        considered=len(cases),
        window_label=(f"The last {len(cases):,} cases of the last {MATCH_PREVIEW_WINDOW_DAYS} days"
                      if len(cases) >= MATCH_PREVIEW_MAX_CASES
                      else f"Last {MATCH_PREVIEW_WINDOW_DAYS} days"),
        gets_it=gets, another_wins=others, near_misses=near, counts=counts, truncated=truncated,
    )


# --------------------------------------------------------------------------- #
# Metrics.
# --------------------------------------------------------------------------- #
def _definition_for(snap_docs: Mapping[str, Any], runbook_id: str, version: int) -> RunbookDefinition | None:
    item = builtin_runbook(runbook_id)
    if item is not None:
        return item.definition
    doc = snap_docs.get(runbook_id)
    if doc is None:
        return None
    found = doc.version(int(version))
    if found is not None:
        return found.definition
    live = doc.live or doc.retired_version
    return live.definition if live is not None else None


def _step_index(defn: RunbookDefinition | None) -> dict[str, tuple[str, str]]:
    if defn is None:
        return {}
    return {s.id: (s.phase, s.title) for s in defn.steps}


async def metrics(
    *,
    library_store: Any,
    runs_store: Any,
    cases_store: Any,
    prefs: Any,
    window: Any,
) -> RunbookMetrics:
    """``GET /api/runbooks/metrics`` (SPEC §4.10.15, §4.10.15a).

    Populations, stated so no figure claims more than it measures:

    * per runbook, per phase and per step: the runs STARTED in the window (from the
      run ledger, written on run-level transitions only); medians over the completed
      ones; skips are the steps marked Not applicable in completed runs;
    * coverage: the human-handled cases CREATED in the window (open, or closed by an
      analyst) and how many of them have a run (from the ledger, any time after);
    * rules without a runbook: rules of cases created in the window for which no
      Published runbook other than the fallback matched;
    * cohorts: the human-handled cases of the window with a measured resolution time,
      split by whether they have a completed run. A comparison, never a cause.

    ``partial`` is true when a ledger month that can hold a run of the window's
    figures reached its cap (any month from the window's first to now: the runs
    started in the window, and the later runs attached to the window's cases that
    coverage counts), when the window reaches back past the ledger's retention, or
    when the case read stopped at :data:`METRICS_MAX_CASES`: every affected figure is
    then a lower bound. A capped month before the window changes none of its figures
    (a run never starts before its case)."""
    from .metrics import lifecycle_intervals

    start: datetime | None = window.start
    end: datetime = window.end
    now = now_utc()
    # Only the months that can hold a run these figures count: from the window's first
    # month to now (the runs started in the window, and the later runs on the window's
    # cases that coverage counts). The figures stay exact: a run never starts before
    # its case, and a run is filed in the month it started.
    rows, capped = await _ledger_months(runs_store, _months_between(start, max(end, now)))
    ledger_partial = bool(capped)
    oldest_month = min(retained_months())
    retention_cut = start is None or start.strftime("%Y-%m") < oldest_month
    snap = await snapshot(library_store)

    def in_window(value: Any) -> bool:
        moment = _parse_ts(value)
        return moment is not None and moment < end and (start is None or moment >= start)

    window_rows = [r for r in rows if in_window(r.started_at)]
    docs: dict[str, Any] = {}
    for runbook_id in sorted({r.runbook_id for r in window_rows}):
        if builtin_runbook(runbook_id) is None:
            try:
                record = await library_store.get(runbook_id)
            except RunbookDocumentDamaged as exc:
                # One damaged runbook never disables the figures of the others: its
                # definition only names steps and phases, so its runs keep their counts
                # and its steps are shown by id.
                logger.warning("runbook metrics: %s left out of step titles: %s", runbook_id[:80], exc)
                continue
            if record is not None:
                docs[runbook_id] = record.runbook

    per_runbook: dict[str, RunbookMetricsRunbookRow] = {}
    durations: dict[str, list[float]] = {}
    phase_minutes: dict[tuple[str, str], list[float]] = {}
    step_minutes: dict[tuple[str, str], list[float]] = {}
    step_skips: dict[tuple[str, str], int] = {}
    step_titles: dict[tuple[str, str], str] = {}
    for row in window_rows:
        entry = per_runbook.setdefault(row.runbook_id, RunbookMetricsRunbookRow(
            id=row.runbook_id, title=snap.title_of(row.runbook_id)))
        entry.started += 1
        if row.status == "abandoned":
            entry.abandoned += 1
        if row.status != "completed":
            continue
        entry.completed += 1
        minutes = _minutes(row.started_at, row.completed_at)
        if minutes is not None:
            durations.setdefault(row.runbook_id, []).append(minutes)
        steps = _step_index(_definition_for(docs, row.runbook_id, row.version))
        phase_sum: dict[str, float] = {}
        for step_id, seconds in (row.step_durations or {}).items():
            if not isinstance(seconds, (int, float)) or seconds < 0:
                continue
            key = (row.runbook_id, step_id)
            step_minutes.setdefault(key, []).append(seconds / 60.0)
            if step_id in steps:
                phase, title = steps[step_id]
                step_titles.setdefault(key, title)
                phase_sum[phase] = phase_sum.get(phase, 0.0) + seconds / 60.0
        for phase, total in phase_sum.items():
            phase_minutes.setdefault((row.runbook_id, phase), []).append(total)
        for step_id in row.skipped_step_ids or []:
            key = (row.runbook_id, step_id)
            step_skips[key] = step_skips.get(key, 0) + 1
            if step_id in steps:
                step_titles.setdefault(key, steps[step_id][1])
    for runbook_id, entry in per_runbook.items():
        entry.median_minutes_to_complete = _median(durations.get(runbook_id, []))

    step_rows = [
        RunbookMetricsStepRow(
            runbook_id=rid, step_id=sid, title=step_titles.get((rid, sid), sid),
            median_minutes=_median(step_minutes.get((rid, sid), [])),
            skipped=step_skips.get((rid, sid), 0),
        )
        for (rid, sid) in set(step_minutes) | set(step_skips)
    ]
    step_rows.sort(key=lambda r: (-r.skipped, r.runbook_id, r.step_id))

    phase_rows = [
        RunbookMetricsPhaseRow(runbook_id=rid, phase=phase, median_minutes=_median(values))
        for (rid, phase), values in sorted(phase_minutes.items())
    ]

    # Cases created in the window.
    cases, case_cap = await cases_in_window(cases_store, start, end)
    case_runs: dict[str, set[str]] = {}
    for row in rows:
        case_runs.setdefault(row.case_id, set()).add(row.status)
    catalog = await matchable(library_store)
    mapping = source_types_of(prefs)

    def fold() -> tuple[dict[str, int], int, int, list[Any], list[Any]]:
        gaps: dict[str, int] = {}
        handled = with_run = 0
        completed_cohort: list[Any] = []
        other_cohort: list[Any] = []
        for case in cases:
            facts = case_facts_from_case(case, prefs=prefs, source_types=mapping)
            rule = _primary_rule(facts)
            if rule is not None and match(facts, catalog, fallback=False).winner is None:
                gaps[rule] = gaps.get(rule, 0) + 1
            if not human_handled(case):
                continue
            handled += 1
            statuses = case_runs.get(str(getattr(case, "case_id", "")), set())
            if statuses:
                with_run += 1
            (completed_cohort if "completed" in statuses else other_cohort).append(case)
        return gaps, handled, with_run, completed_cohort, other_cohort

    # The fold is pure; a large window runs off the event loop.
    if len(cases) > _FOLD_OFFLOAD_AT:
        gaps, handled, with_run, completed_cohort, other_cohort = await asyncio.to_thread(fold)
    else:
        gaps, handled, with_run, completed_cohort, other_cohort = fold()

    def cohort(group: list[Any]) -> RunbookMetricsCohort:
        if not group:
            return RunbookMetricsCohort(cases=0, mttr_p50_minutes=None)
        block = lifecycle_intervals(group)["mttr_minutes"]
        count = int(block.get("count") or 0)
        p50 = block.get("p50")
        return RunbookMetricsCohort(
            cases=count,
            mttr_p50_minutes=float(p50) if isinstance(p50, (int, float)) and count else None,
        )

    gap_rows = [
        RunbookMetricsRuleGap(rule=rule, cases=count)
        for rule, count in sorted(gaps.items(), key=lambda item: (-item[1], item[0]))[:METRICS_MAX_RULE_GAPS]
    ]

    recent = await _recent_runs(window_rows, runs_store=runs_store, cases_store=cases_store,
                                snap=snap, now=now)
    return RunbookMetrics(
        window_label=_sentence_label(window.label),
        partial=bool(ledger_partial or retention_cut or case_cap),
        per_runbook=sorted(per_runbook.values(), key=lambda r: (-r.started, r.title.casefold(), r.id)),
        per_phase=phase_rows,
        per_step=step_rows[:METRICS_MAX_STEP_ROWS],
        coverage=RunbookMetricsCoverage(cases_with_run=with_run, human_handled_cases=handled),
        rules_without_runbook=gap_rows,
        cohorts=RunbookMetricsCohorts(with_completed_run=cohort(completed_cohort), without=cohort(other_cohort)),
        recent_runs=recent,
    )


async def _recent_runs(rows: list[Any], *, runs_store: Any, cases_store: Any, snap: CatalogSnapshot,
                       now: datetime) -> list[RunbookMetricsRecentRun]:
    """The newest :data:`METRICS_MAX_RECENT_RUNS` runs of the window, with the case
    number and who attached each run (read from at most that many case documents)."""
    newest = sorted(rows, key=lambda r: (_parse_ts(r.started_at) or now, r.run_id), reverse=True)
    newest = newest[:METRICS_MAX_RECENT_RUNS]
    if not newest:
        return []
    case_ids = list(dict.fromkeys(r.case_id for r in newest))
    numbers: dict[str, str] = {}
    actors: dict[str, str] = {}
    try:
        found = await cases_store.get_many(case_ids)
        numbers = {cid: str(getattr(case, "case_number", "") or "") for cid, case in (found or {}).items()}
    except Exception as exc:  # noqa: BLE001 - case numbers are a convenience
        logger.warning("runbook metrics: case numbers not read: %s", exc)
    try:
        for case_runs in (await runs_store.get_many(case_ids)).values():
            for run in case_runs.runs:
                actors[run.run_id] = run.attached_actor
    except Exception as exc:  # noqa: BLE001 - the actor is a convenience
        logger.warning("runbook metrics: run documents not read: %s", exc)
    out: list[RunbookMetricsRecentRun] = []
    for r in newest:
        minutes = _minutes(r.started_at, r.completed_at) if r.status == "completed" else None
        out.append(RunbookMetricsRecentRun(
            run_id=r.run_id, case_id=r.case_id, case_number=numbers.get(r.case_id, ""),
            runbook_id=r.runbook_id, title=snap.title_of(r.runbook_id), version=r.version,
            status=r.status, attached_actor=actors.get(r.run_id, ""), started_at=r.started_at,
            completed_at=r.completed_at, duration_minutes=round(minutes, 1) if minutes is not None else None,
        ))
    return out


# --------------------------------------------------------------------------- #
# The one-release old shape (``?shape=v1``).
# --------------------------------------------------------------------------- #
def _split_front_matter(text: str) -> str:
    if text.startswith("---\n"):
        end = text.find("\n---", 4)
        if end != -1:
            return text[end + 4:].lstrip("\n")
    return text


def _index_status(runbook_id: str, version: int, *, enabled: bool, projection: Mapping[str, int]) -> tuple[str, int | None]:
    if not enabled:
        return "disabled", None
    projected = int(projection.get(runbook_id, 0) or 0)
    if projected == version:
        return "ready", projected
    if projected:
        return "stale", projected
    return "pending", None


def v1_item(*, runbook_id: str, version: RunbookVersionDoc, builtin: BuiltinRunbook | None, doc: Any | None,
            enabled: bool, projection: Mapping[str, int], include_content: bool) -> dict[str, Any]:
    """One Published runbook in the old runbook item shape (read-only: ``editable`` is
    false because old-shape writes answer ``410``)."""
    defn = version.definition
    content = export_markdown(version)
    body = _split_front_matter(content)
    status, indexed = _index_status(runbook_id, version.version, enabled=enabled, projection=projection)
    techniques = list(dict.fromkeys([*defn.mitre, *defn.applies_when.mitre]))
    # The alias serves Published text to every ``runbooks:read`` holder, so its
    # ``updated_at`` and ``updated_by`` describe the published record, as the new
    # shape does for a reader (:func:`_public_touch`): the document's own last touch
    # also moves on a hidden draft save, submit, rejection or discard, and draft
    # activity is visible only to holders of ``manage`` or ``publish`` (SPEC §4.10.15).
    touched_at, touched_by = _public_touch(index_row_for(doc, 0)) if doc is not None else (None, None)
    out: dict[str, Any] = {
        "id": runbook_id,
        "title": defn.title,
        "summary": defn.summary,
        "persona": defn.owner or "",
        "applies_to_rules": list(defn.applies_when.rule_ids),
        "applies_to_techniques": techniques,
        "applies_to_entities": list(defn.applies_when.entity_types),
        "keywords": list(defn.applies_when.any_tags),
        "body_characters": len(body),
        "source_type": "bundled" if builtin is not None else "operator",
        "protected": builtin is not None,
        "editable": False,
        # The old shape's types are kept for the clients it exists for: a file name,
        # an integer revision of the index and a string time, never null.
        "file_name": builtin.file_name if builtin is not None else f"{runbook_id}.md",
        "revision": version.version,
        "created_at": (doc.created_at if doc is not None else "") or "",
        "updated_at": touched_at or "",
        "created_by": (doc.created_by if doc is not None else "") or "",
        "updated_by": touched_by or "",
        "index_status": status,
        "indexed_revision": indexed if indexed is not None else 0,
        "last_indexed_at": "",
        "index_error": "",
    }
    if include_content:
        out["content"] = content
        out["body"] = body
    return out


async def published_versions(library_store: Any) -> list[tuple[str, RunbookVersionDoc, BuiltinRunbook | None, Any | None]]:
    """Every Published runbook (built-ins and live operator versions), by id."""
    out: list[tuple[str, RunbookVersionDoc, BuiltinRunbook | None, Any | None]] = [
        (b.id, builtin_version_doc(b), b, None) for b in load_builtin_runbooks()
    ]
    builtin_ids = set(BUILTIN_RUNBOOK_IDS)
    for item in await library_store.published_catalog():
        if item.runbook.id not in builtin_ids:
            out.append((item.runbook.id, item.live, None, item.runbook))
    out.sort(key=lambda entry: entry[0])
    return out


# --------------------------------------------------------------------------- #
# The RAG reprojection hook.
# --------------------------------------------------------------------------- #
async def reproject(rag: Any, ids: set[str]) -> dict[str, Any] | None:
    """Ask the retrieval index to reproject ``ids`` after a publish, retire or restore
    (SPEC §4.10.18), so a retired runbook's text stops being retrieved and a newly
    published one starts. Runs only once the retrieval service carries the
    Published-only runbook projection (``project_runbook_corpus``): before it, the
    projection still reads the retired documents, and reindexing them could serve
    legacy text as trusted (#9). Best-effort: the change is saved and audited whatever
    happens here, and a failure is logged (the next full reindex repairs it)."""
    if rag is None or not callable(getattr(rag, "project_runbook_corpus", None)):
        return None
    reindex = getattr(rag, "reindex_runbooks", None)
    if not callable(reindex):
        return None
    try:
        return await reindex(set(ids))
    except Exception as exc:  # noqa: BLE001 - the write is saved; retrieval catches up
        logger.warning("runbook retrieval reprojection failed for %s: %s", sorted(ids)[:5], exc)
        return None


# --------------------------------------------------------------------------- #
# Audit changes.
# --------------------------------------------------------------------------- #
def audit_change(field_name: str, before: Any, after: Any) -> dict[str, Any] | None:
    """One ``changes`` entry, or ``None`` when nothing moved. Values are recorded as
    the person wrote them (a review note that starts with a date is kept verbatim):
    the audit row holds the actual value. The audit mapping stores ``changes``
    unindexed with date detection off (SPEC §4.5.3, ``es.indices.AUDIT_MAPPING``), so
    no value can turn a field into a date. No change here is a timestamp."""
    def text(value: Any) -> str | None:
        return None if value is None else str(value)

    if before == after:
        return None
    return {"field": field_name, "before": text(before), "after": text(after)}


def definition_changes(before: RunbookDefinition | None, after: RunbookDefinition) -> list[dict[str, Any]]:
    """What changed between two definitions, as audit ``changes``: the title, the
    summary, the step count, the phases and the content hash (the full text is in the
    version history, never in the audit row)."""
    out: list[dict[str, Any] | None] = [
        audit_change("title", before.title if before else None, after.title),
        audit_change("summary", before.summary if before else None, after.summary),
        audit_change("steps", len(before.steps) if before else None, len(after.steps)),
        audit_change("phases", ",".join(before.phases) if before else None, ",".join(after.phases)),
        audit_change("content_hash", content_hash(before) if before else None, content_hash(after)),
    ]
    return [c for c in out if c is not None]


def state_changes(before: Any, after: Any) -> list[dict[str, Any]]:
    """The version states that moved between two documents (``version 4 state``)."""
    old = {v.version: v.state for v in (before.versions if before is not None else [])}
    new = {v.version: v.state for v in (after.versions if after is not None else [])}
    out: list[dict[str, Any]] = []
    for number in sorted(set(old) | set(new)):
        change = audit_change(f"version {number} state", old.get(number), new.get(number))
        if change is not None:
            out.append(change)
    return out


__all__ = [
    "BUILTIN_AUTHOR",
    "CatalogError",
    "CatalogSnapshot",
    "DEPRECATION_HEADERS",
    "MATCH_PREVIEW_MAX_CASES",
    "METRICS_DEFAULT_WINDOW",
    "RUNBOOK_BODY_MAX_BYTES",
    "audit_change",
    "builtin_detail",
    "builtin_summary",
    "blocking_parse_issues",
    "builtin_version_doc",
    "cases_in_window",
    "definition_changes",
    "definition_from_body",
    "draft_blocking_issues",
    "duplicate_plan",
    "export_file_name",
    "export_markdown",
    "human_handled",
    "import_plan",
    "issues_error",
    "ledger_rows",
    "library",
    "match_preview",
    "matchable",
    "metrics",
    "new_operator_runbook",
    "open_runs_by_version",
    "operator_detail",
    "published_versions",
    "reproject",
    "runbooks_moved_response",
    "runs_started_since",
    "snapshot",
    "state_changes",
    "summary_from_row",
    "t_discard_draft",
    "t_publish",
    "t_reject",
    "t_restore",
    "t_restore_version",
    "t_retire",
    "t_reviewed",
    "t_save_draft",
    "t_submit",
    "v1_item",
    "validation",
    "with_review_default",
    "working_version",
]
