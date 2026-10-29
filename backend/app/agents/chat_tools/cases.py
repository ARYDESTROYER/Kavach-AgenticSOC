"""Case tools: ``search_cases``, ``get_case``, ``shift_report``, ``list_campaigns``
and ``explain_decision`` (chat revamp SPEC §5.3).

All five read the demo-switchable case/campaign/standup stores on the context and
write nothing. Case text (titles, entities, rule ids, evidence summaries, status
reasons, campaign names) is log- or model-derived, so it reaches a model only inside
the engine's fence and is flagged ``untrusted_labels`` on artifacts (#9). No
observation ever carries ``member_event_ids``, ``history``, ``verdict_history``,
comments or notification records.

``explain_decision`` calls the pure, deterministic ``case_manager.decide()`` exactly
like ``POST /api/triage/preview-decision``: a what-if over the LIVE execution
policy, never a write, never a model call, never a different policy (#3).
"""

from __future__ import annotations

import inspect
import logging
import math
from collections import Counter
from typing import Any, ClassVar, Literal, NamedTuple

from pydantic import Field, PrivateAttr, field_validator

from ...constants import OPEN_CASE_STATUSES, TERMINAL_CASE_STATUSES, CaseStatus, Verdict
from ...models import PHASE_LABELS, Citation, humanise_relative_window
from .base import Artifact, ChatTool, ChatToolContext, ToolOutcome
from .common import (
    CASE_STATUS_WORDS,
    PREVIOUS_WINDOW_LABEL,
    ToolInput,
    case_list_item,
    citation_id,
    case_row,
    case_severity,
    categories,
    column,
    enum_value,
    finite,
    fmt_int,
    iso_or_none,
    kpi,
    none_if_blank,
    opt_text,
    parse_input,
    resolve_window,
    status_change_detail,
    status_change_label,
    text,
    verdict_semantic,
    whole_periods,
    window_input,
)

logger = logging.getLogger("tlsoc.agents.chat_tools.cases")

# The shared bounded page the dashboards use (5 s single-flight cache, demo-safe by
# store identity). In-memory filters run over at most this many newest cases.
CASE_SCAN_LIMIT = 5_000
_OBS_CASES = 10
_CASE_LIST_MAX = 25
# A native query in a case rationale is bounded like ``audit_search``'s query_text.
_RATIONALE_QUERY_CHARS = 200
# The audit ``query_text`` of explain_decision's forwarding read (engine text).
_FORWARDING_READ = "forwarding explanation: re-read the case's member events from its log source"

_STATUSES = tuple(s.value for s in CaseStatus)
_VERDICTS = tuple(v.value for v in Verdict)
_ENTITY_KIND = {"ip": "ip", "user": "user", "host": "host", "file_hash": "hash", "domain": "domain"}


async def load_case_page(ctx: ChatToolContext, *, fresh: bool = False) -> tuple[list[Any], int, bool]:
    """``(cases, store_total, ok)`` from the shared page cache (``fresh``: read now,
    never the cached page); a store failure is reported (``ok=False``), never presented
    as an empty store."""
    from ...api.metrics_shared import fetch_case_page

    if ctx.cases is None:
        return [], 0, False
    try:
        cases, total = await fetch_case_page(ctx.cases, CASE_SCAN_LIMIT, fresh=fresh)
        return list(cases), int(total), True
    except Exception as exc:  # noqa: BLE001 — degrade, never raise into the turn
        logger.warning("chat case page load failed: %s", exc)
        return [], 0, False


def _norm_enum(value: Any, allowed: tuple[str, ...], *, upper: bool = False) -> Any:
    value = none_if_blank(value)
    if isinstance(value, str):
        candidate = value.strip().upper() if upper else value.strip().lower()
        candidate = candidate.replace(" ", "_").replace("-", "_")
        if candidate in allowed:
            return candidate
    return value


# --------------------------------------------------------------------------- #
# search_cases
# --------------------------------------------------------------------------- #
class CaseFilters(ToolInput):
    """The case filters ``search_cases`` and ``case_stats`` share, and the window
    (Round 12: ``window`` accepts all time, calendar periods and ISO ranges of any
    length; ``window_hours`` stays as an alias). No window means ALL TIME."""

    text: str | None = Field(default=None, max_length=120)
    status: Literal[_STATUSES] | None = None  # type: ignore[valid-type]
    status_group: Literal["active", "terminal"] | None = None
    verdict: Literal[_VERDICTS] | None = None  # type: ignore[valid-type]
    entity: str | None = Field(default=None, max_length=256)
    severity: Literal["critical", "high", "medium", "low", "info"] | None = None
    priority: Literal["P1", "P2", "P3", "P4"] | None = None
    assignee: str | None = Field(default=None, max_length=128)
    rule: str | None = Field(default=None, max_length=128)
    window: str | dict[str, Any] | None = None
    window_hours: int | None = Field(default=None, ge=1)
    #: Set by :func:`resolve_assignee_me`: ``assignee`` is the signed-in analyst's
    #: username, matched as that exact name (never as an unassigned keyword).
    _assignee_exact: bool = PrivateAttr(default=False)

    @field_validator("text", "entity", "assignee", "rule", "window_hours", mode="before")
    @classmethod
    def _blank(cls, value: Any) -> Any:
        return none_if_blank(value)

    @field_validator("window", mode="before")
    @classmethod
    def _window(cls, value: Any) -> Any:
        return window_input(value)

    @field_validator("status", mode="before")
    @classmethod
    def _status(cls, value: Any) -> Any:
        return _norm_enum(value, _STATUSES)

    @field_validator("status_group", mode="before")
    @classmethod
    def _group(cls, value: Any) -> Any:
        value = _norm_enum(value, ("active", "terminal", "open", "closed"))
        return {"open": "active", "closed": "terminal"}.get(value, value) if isinstance(value, str) else value

    @field_validator("verdict", mode="before")
    @classmethod
    def _verdict(cls, value: Any) -> Any:
        return _norm_enum(value, _VERDICTS, upper=True)

    @field_validator("severity", mode="before")
    @classmethod
    def _severity(cls, value: Any) -> Any:
        return _norm_enum(value, ("critical", "high", "medium", "low", "info"))

    @field_validator("priority", mode="before")
    @classmethod
    def _priority(cls, value: Any) -> Any:
        return _norm_enum(value, ("P1", "P2", "P3", "P4"), upper=True)

    def memory_filters(self) -> bool:
        return any(getattr(self, k) is not None for k in ("text", "verdict", "severity", "priority", "assignee", "rule"))

    def filters(self) -> dict[str, Any]:
        keys = ("text", "status", "status_group", "verdict", "entity", "severity", "priority", "assignee", "rule")
        return {k: getattr(self, k) for k in keys if getattr(self, k) is not None}

    def aggregate_filters(self) -> dict[str, Any]:
        """:meth:`filters` as the case aggregator takes them: the signed-in analyst's
        username goes as ``assignee_user`` (an exact name), so a username such as
        "nobody" or "none" never reads as the unassigned keyword."""
        out = self.filters()
        if self._assignee_exact and "assignee" in out:
            out["assignee_user"] = out.pop("assignee")
        return out

    def has_window(self) -> bool:
        return self.window is not None or self.window_hours is not None


#: The ``assignee`` value that names the signed-in analyst ("my cases", Round 13 polish).
#: The case tools resolve it on the server to the caller's username, matched like every
#: assignee (trimmed, case-insensitive); with nobody signed in (auth off) it names no
#: one, so it matches no case and the result says so. Any other value is a username, as
#: before: the case rows already show every case's assignee to anyone who may read cases.
ASSIGNEE_ME = "me"
ASSIGNEE_ME_NOBODY = 'No analyst is signed in (sign-in is off), so assignee "me" matches no case'
#: The observation note of a lookup that resolved assignee "me" (search_cases, case_stats).
ASSIGNEE_ME_OWN = "the signed-in analyst's own cases"


def resolve_assignee_me(ctx: ChatToolContext, args: Any) -> tuple[Any, bool | None]:
    """``(args, me)``: ``args`` with assignee "me" replaced by the caller's username.
    ``me`` is None when the input did not ask for "me", True when it was resolved, and
    False when "me" was asked but nobody is signed in (``args`` unchanged)."""
    value = getattr(args, "assignee", None)
    if not isinstance(value, str) or value.strip().lower() != ASSIGNEE_ME:
        return args, None
    caller = (getattr(ctx, "caller", "") or "").strip()
    if not caller:
        return args, False
    resolved = args.model_copy(update={"assignee": caller})
    resolved._assignee_exact = True
    return resolved, True


class SearchCasesInput(CaseFilters):
    sort_field: Literal["created_at", "updated_at", "risk_score"] = "created_at"
    sort_order: Literal["desc", "asc"] = "desc"
    limit: int = Field(default=20, ge=1, le=50)


def _case_matches(case: Any, args: SearchCasesInput, prefs: Any, window: Any) -> bool:
    status = enum_value(case.status)
    if args.status and status != args.status:
        return False
    if args.status_group == "active" and status not in OPEN_CASE_STATUSES:
        return False
    if args.status_group == "terminal" and status not in TERMINAL_CASE_STATUSES:
        return False
    if args.verdict and enum_value(case.verdict) != args.verdict:
        return False
    if args.entity and str(getattr(case.entity, "value", "")) != args.entity:
        return False
    if args.severity and case_severity(case, prefs) != args.severity:
        return False
    if args.priority:
        from .common import case_priority

        if case_priority(case, prefs) != args.priority:
            return False
    if args.assignee is not None:
        wanted = args.assignee.strip().lower()
        actual = (case.assignee or "").strip().lower()
        if getattr(args, "_assignee_exact", False):
            # The signed-in analyst: an exact username, even "nobody" or "none".
            if actual != wanted:
                return False
        elif wanted in ("unassigned", "none", "nobody", "(unassigned)"):
            if actual:
                return False
        elif actual != wanted:
            return False
    if args.rule and args.rule.lower() not in {str(r).lower() for r in case.rule_ids or []}:
        return False
    if args.text:
        needle = args.text.lower()
        hay = " ".join(str(v) for v in (
            case.case_id, case.case_number, case.title, getattr(case.entity, "value", ""),
            case.source_name, " ".join(case.tags or []), " ".join(case.rule_ids or []),
        ) if v)
        if needle not in hay.lower():
            return False
    if window is not None:
        created = _created(case)
        if created is None:
            # A case without a parseable creation time cannot be placed in a bounded
            # window: like the aggregator and the dashboards, only an unbounded (all
            # time) window counts it; a bounded one discloses it as ``missing_created``.
            return _undated_counted(window)
        if not (window.start <= created <= window.end):
            return False
    return True


def _undated_counted(window: Any) -> bool:
    """Does ``window`` count a case with no parseable creation time? Only an unbounded
    one (all time, ending now): the dashboards' rule, which the aggregator follows."""
    return bool(getattr(window, "all_time", False) and getattr(window, "trailing", False))


def _created(case: Any):
    from datetime import datetime, timezone

    raw = getattr(case, "created_at", None)
    if not isinstance(raw, str) or not raw:
        return None
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _sort_phrase(field: str, order: str) -> str:
    """What the listed rows are, in words ("newest", "highest-risk")."""
    desc = order == "desc"
    if field == "risk_score":
        return "highest-risk" if desc else "lowest-risk"
    if field == "updated_at":
        return "most recently updated" if desc else "least recently updated"
    return "newest" if desc else "oldest"


def _sort_cases(cases: list[Any], field: str, order: str) -> list[Any]:
    def key(case: Any) -> Any:
        if field == "risk_score":
            return finite(case.risk_score) or 0.0
        return str(getattr(case, field, "") or "")
    return sorted(cases, key=key, reverse=(order == "desc"))


class _Listing(NamedTuple):
    """What ``search_cases`` lists: the display rows, the listing's own count, whether
    that count covers every case, how many cases the page scanned, and (in-memory
    filters only) every match on the case page, for :func:`_page_agrees`."""

    page: list[Any]
    count: int
    exact: bool
    scanned: int | None
    matched: list[Any] | None


def _breakdown_key(verdict: Any, status: Any) -> tuple[str, str]:
    return (str(enum_value(verdict) or "").upper(), str(enum_value(status) or "").lower())


def _page_agrees(listing: _Listing, counts: Any) -> bool:
    """Do the case page's matches describe the same cases as the exact count (the
    total, and the cases by verdict and status)? A page that holds only the newest
    cases agrees unless it holds more matches than exist. ``True`` when there is
    nothing to compare (no in-memory filter, no exact count)."""
    from .stats import is_exact

    if counts is None or listing.matched is None or not is_exact(counts):
        return True
    total = int(finite(getattr(counts, "total", None)) or 0)
    if not listing.exact:
        return listing.count <= total
    if listing.count != total:
        return False
    counted: Counter[tuple[str, str]] = Counter()
    for group in getattr(counts, "groups", None) or []:
        key = group.get("key") if isinstance(group, dict) else None
        if isinstance(key, dict):
            counted[_breakdown_key(key.get("verdict"), key.get("status"))] += int(
                finite((group.get("metrics") or {}).get("count")) or 0)
    return not counted or counted == Counter(_breakdown_key(c.verdict, c.status) for c in listing.matched)


def _page_counts(matched: list[Any]) -> Any:
    """The figures ``search_cases`` states (the total, by verdict and status, the
    average risk) counted from the matches of a case page that holds every case: the
    same read as the rows."""
    from ...engine.case_aggregate import AggregateResult

    groups = Counter((enum_value(c.verdict) or None, enum_value(c.status) or None) for c in matched)
    risks = [r for r in (finite(c.risk_score) for c in matched) if r is not None]
    return AggregateResult(
        total=len(matched),
        groups=[{"key": {"verdict": v, "status": s}, "bucket": None, "metrics": {"count": n}}
                for (v, s), n in groups.items()],
        buckets=[], exact=True, consistency="point_in_time", scanned=len(matched),
        totals={"count": len(matched), "mean_risk": round(sum(risks) / len(risks), 1) if risks else None},
    )


#: At most this many extra rows are read to refill a page after undated cases (not
#: counted in a bounded window) are left out of the listing.
_UNDATED_EXTRA_ROWS = 50


class SearchCasesTool(ChatTool):
    name: ClassVar[str] = "search_cases"
    label: ClassVar[str] = "Searched cases"
    running_label: ClassVar[str] = "Searching cases"
    scope: ClassVar[str] = "cases"
    requires: ClassVar[tuple[tuple[str, str], ...]] = (("cases", "read"),)
    data_source: ClassVar[str] = "Case store"
    input_model: ClassVar[type] = SearchCasesInput
    timeout_s: ClassVar[float] = 600
    signature: ClassVar[str] = (
        "search_cases(text?, status?, status_group?=active|terminal, verdict?=TRUE_POSITIVE|FALSE_POSITIVE|"
        "NEEDS_HUMAN, entity?, severity?, priority?=P1..P4, assignee? (me = signed-in analyst), rule?, window?, "
        "sort_field?=created_at|updated_at|risk_score, sort_order?, limit?=20 (<=50)) -- list matching cases with "
        "an EXACT count and verdict and status counts over every case"
    )
    display_keys: ClassVar[tuple[str, ...]] = (
        "text", "status", "status_group", "verdict", "entity", "severity", "priority",
        "assignee", "rule", "window", "window_hours", "sort_field", "limit",
    )

    def display_params(self, inp: dict[str, Any]) -> dict[str, Any]:
        params = dict(inp) if isinstance(inp, dict) else {}
        if isinstance(params.get("window"), dict):
            params["window"] = "..".join(str(v) for v in params["window"].values())[:80]
        return super().display_params(params)

    async def run(self, ctx: ChatToolContext, **inp: Any) -> ToolOutcome:
        args, error = parse_input(SearchCasesInput, inp)
        if error is not None:
            return error
        if args.status and args.status_group:
            return ToolOutcome.failure("Invalid input: choose status or status_group, not both")
        if ctx.cases is None:
            return ToolOutcome.failure("The case store is not available")
        window = resolve_window(ctx, window=args.window, window_hours=args.window_hours, default="all",
                                minutes_ok=False)
        if isinstance(window, str):
            return ToolOutcome.failure(window)
        # The same start as every other case lookup of this window in the answer.
        window = whole_periods(window)
        args, me = resolve_assignee_me(ctx, args)
        if me is False:
            return self._nobody_signed_in(ctx, args, window)
        counts = await self._exact_counts(ctx, args, window)
        # A bounded window does not count cases with no creation date (the aggregator
        # discloses them as ``missing_created``), so it does not list them either: the
        # rows always match the count. Ask the store for that many more rows to fill
        # the page after they are left out.
        undated = int(finite(getattr(counts, "missing_created", 0)) or 0) if counts is not None else 0
        drop_undated = undated > 0 and not bool(getattr(counts, "missing_in_total", True))
        extra = min(undated, _UNDATED_EXTRA_ROWS) if drop_undated else 0
        listing = await self._list_rows(ctx, args, window, extra=extra)
        if isinstance(listing, ToolOutcome):
            return listing
        if args.memory_filters() and not _page_agrees(listing, counts):
            # The shared case page (kept a few seconds so the lookups of one answer
            # share one read) predates the count just taken: a case changed in between,
            # e.g. it was assigned a moment ago. Read the page again now, so the rows
            # describe the same cases as the count (Round 13 close: "3 open cases are
            # assigned to you" with none listed).
            listing = await self._list_rows(ctx, args, window, extra=extra, fresh=True)
            if isinstance(listing, ToolOutcome):
                return listing
            if not _page_agrees(listing, counts) and listing.exact and listing.matched is not None:
                # Still apart (a case changed between the two reads): the page holds
                # every case, so the figures come from it too, the same read as the rows.
                counts = _page_counts(listing.matched)
                drop_undated = False
        page, listed_count, listed_exact, scanned = listing.page, listing.count, listing.exact, listing.scanned
        if drop_undated:
            kept = [c for c in page if _created(c) is not None]
            listed_count = max(0, listed_count - (len(page) - len(kept)))
            page = kept[: args.limit]
        unlisted = 0
        if (args.memory_filters() and not listed_exact and counts is not None
                and int(getattr(counts, "total", 0) or 0) > listed_count):
            # The newest-cases page holds only some of the matches: list from every
            # case instead (a streaming scan that keeps the top ``limit`` rows), so
            # the rows are really the newest (or highest-risk) matches.
            streamed = await self._scan_rows(ctx, args, window)
            if streamed is not None:
                page, listed_count = streamed
                listed_exact, scanned = True, None
            else:
                unlisted = int(getattr(counts, "total", 0) or 0) - listed_count
        outcome = self._outcome(ctx, args, window, page, listed_count, listed_exact, scanned, counts,
                                unlisted=unlisted)
        if me:
            outcome.observation["assignee_me"] = ASSIGNEE_ME_OWN
        return outcome

    def _nobody_signed_in(self, ctx: ChatToolContext, args: SearchCasesInput, window: Any) -> ToolOutcome:
        """Assignee "me" with nobody signed in: an exact zero, said plainly (no read).

        No block: a "Matching cases 0" figure or an empty case list would read as a
        fact about the queue, when the lookup could not ask the question at all. The
        only next lookup offered drops the assignee filter (any other would still
        carry "me" and be refused the same way)."""
        outcome = self._outcome(ctx, args, window, [], 0, True, None, None)
        outcome.observation["assignee_me"] = ASSIGNEE_ME_NOBODY
        outcome.observation["suggestions"] = [
            s for s in outcome.observation.get("suggestions") or []
            if isinstance(s, dict) and "assignee" not in (s.get("input") or {})
        ]
        if not outcome.observation["suggestions"]:
            outcome.observation.pop("suggestions")
        outcome.artifacts = []
        outcome.summary = f"{ASSIGNEE_ME_NOBODY} ({window.label})"
        outcome.coverage = ASSIGNEE_ME_NOBODY
        return outcome

    async def _scan_rows(
        self, ctx: ChatToolContext, args: SearchCasesInput, window: Any,
    ) -> tuple[list[Any], int] | None:
        """``(top rows by the sort, every match counted)`` from a streaming scan of the
        whole store (only ``limit`` rows are kept), or ``None`` when the scan could not
        finish (the caller then says which rows it could not list)."""
        from ...engine.case_aggregate import scan_cases
        from ...models import Case

        kept: list[Any] = []
        matched = 0
        cap = max(args.limit * 4, 200)

        def consume(rows: list[Any]) -> None:
            nonlocal kept, matched
            for row in rows:
                case = row
                if isinstance(row, dict):
                    try:
                        case = Case.model_validate(row)
                    except Exception:  # noqa: BLE001 — an unreadable row is not a match
                        continue
                if _case_matches(case, args, ctx.prefs, window):
                    matched += 1
                    kept.append(case)
            if len(kept) > cap:
                kept = _sort_cases(kept, args.sort_field, args.sort_order)[: args.limit]

        try:
            outcome = await scan_cases(
                ctx.cases, consume,
                created_from=None if window.all_time else window.start,
                created_to=None if window.all_time and window.trailing else window.end,
            )
        except Exception as exc:  # noqa: BLE001 — the page's rows still stand, labelled
            logger.info("search_cases listing scan failed: %s", exc)
            return None
        if not outcome.complete:
            return None
        return _sort_cases(kept, args.sort_field, args.sort_order)[: args.limit], matched

    async def _list_rows(
        self, ctx: ChatToolContext, args: SearchCasesInput, window: Any, *, extra: int = 0, fresh: bool = False,
    ) -> _Listing | ToolOutcome:
        """The DISPLAY rows (newest first, at most ``limit``, plus ``extra`` from the
        store when undated rows will be left out) and the listing's own count. The
        count is only a fallback: the exact total comes from the aggregator. ``fresh``
        reads the case page now instead of the shared few-seconds-old copy."""
        if args.memory_filters():
            cases, store_total, ok = await load_case_page(ctx, fresh=fresh)
            if not ok:
                return ToolOutcome.failure("The case store did not answer")
            matched = _sort_cases(
                [c for c in cases if _case_matches(c, args, ctx.prefs, window)],
                args.sort_field, args.sort_order,
            )
            return _Listing(matched[: args.limit], len(matched), store_total <= len(cases), len(cases), matched)
        try:
            page, count, exact = await ctx.cases.list_window(
                created_from=window.created_from,
                created_to=None if window.all_time and window.trailing else window.iso_to(),
                status=args.status, status_group=args.status_group,
                entity_value=args.entity, limit=args.limit + max(0, int(extra)),
                sort_field=args.sort_field, sort_order=args.sort_order,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("search_cases list failed: %s", exc)
            return ToolOutcome.failure("The case store did not answer")
        return _Listing(list(page), int(count), bool(exact), None, None)

    async def _exact_counts(self, ctx: ChatToolContext, args: SearchCasesInput, window: Any) -> Any:
        """Exact counts over every matching case (SPEC D8): the total, by verdict and
        by status, and the average risk, from ONE aggregate. ``None`` when the store
        cannot aggregate (the listing's own count then stands, labelled as such)."""
        from .stats import run_case_aggregate

        try:
            return await run_case_aggregate(
                ctx, window, filters=args.aggregate_filters(), group_by=("verdict", "status"),
                metrics=("count", "mean_risk"),
            )
        except Exception as exc:  # noqa: BLE001 — degrade to the listing's count
            logger.info("search_cases exact count unavailable: %s", exc)
            return None

    def _outcome(
        self, ctx: ChatToolContext, args: SearchCasesInput, window: Any, page: list[Any],
        listed_count: int, listed_exact: bool, scanned: int | None, agg: Any, *, unlisted: int = 0,
    ) -> ToolOutcome:
        prefs = ctx.prefs
        by_verdict: Counter[str] = Counter()
        by_status: Counter[str] = Counter()
        avg_risk: float | None = None
        if agg is not None:
            count = int(getattr(agg, "total", 0) or 0)
            exact = bool(getattr(agg, "exact", True))
            for group in getattr(agg, "groups", None) or []:
                key = group.get("key") if isinstance(group, dict) else None
                metrics = group.get("metrics") if isinstance(group, dict) else None
                if not isinstance(key, dict) or not isinstance(metrics, dict):
                    continue
                n = int(finite(metrics.get("count")) or 0)
                by_verdict[enum_value(key.get("verdict")) or "none"] += n
                by_status[enum_value(key.get("status")) or "unknown"] += n
            avg_risk = finite((getattr(agg, "totals", None) or {}).get("mean_risk"))
            breakdown_known = exact
        else:
            # The listing's own count: exact for a store push-down, a lower bound when
            # an in-memory filter could only scan the newest cases.
            count, exact = listed_count, listed_exact
            complete = exact and count <= len(page)
            if complete:
                by_verdict.update(enum_value(c.verdict) or "none" for c in page)
                by_status.update(enum_value(c.status) or "unknown" for c in page)
                risks = [finite(c.risk_score) for c in page if finite(c.risk_score) is not None]
                avg_risk = round(sum(risks) / len(risks), 1) if risks else None
            breakdown_known = complete
        count = max(count, len(page)) if not exact else count
        # "Still open": every match when the filter itself selects open cases; else the
        # exact status breakdown. Never a count of the returned page (screenshot 4).
        if args.status_group == "active" or (args.status in OPEN_CASE_STATUSES):
            open_count: int | None = count
            open_exact = exact
        elif args.status_group == "terminal" or (args.status in TERMINAL_CASE_STATUSES):
            open_count, open_exact = 0, True
        elif breakdown_known:
            open_count = sum(n for s, n in by_status.items() if s in OPEN_CASE_STATUSES)
            open_exact = exact
        else:
            open_count, open_exact = None, False
        observation: dict[str, Any] = {
            "filters": args.filters(),
            "window": window.label,
            "window_clamped_to_request": window.clamped,
            "count": count,
            "exact": bool(exact),
            "count_source": "exact aggregate" if agg is not None else "listing",
            "returned": len(page),
            "cases": [case_row(c, prefs) for c in page[:_OBS_CASES]],
        }
        if unlisted > 0 and scanned is not None:
            # The rows come from the newest-cases page only (the full scan failed).
            observation["listing"] = (
                f"the {fmt_int(len(page))} rows come from the newest {fmt_int(scanned)} cases; "
                f"{fmt_int(unlisted)} matches are older and not listed; the count covers every match"
            )
        elif count > len(page):
            observation["listing"] = (
                f"the {fmt_int(len(page))} rows are the {_sort_phrase(args.sort_field, args.sort_order)} "
                "matches; the count covers every match"
            )
        if scanned is not None and (agg is None or unlisted > 0):
            observation["scanned"] = scanned
        if breakdown_known:
            observation["by_verdict"] = dict(by_verdict)
            observation["by_status"] = dict(by_status)
        if open_count is not None:
            observation["open"] = open_count
        if avg_risk is not None:
            observation["average_risk"] = round(avg_risk, 1)
        if count == 0:
            from .stats import zero_case_suggestions

            observation["suggestions"] = zero_case_suggestions(args, window, "search_cases")
        from .stats import counted_share, missing_created_note

        missing, missing_in_total, missing_note = (
            missing_created_note(agg) if agg is not None else (0, True, None))
        if missing:
            observation["missing_created"] = missing
            observation["missing_created_in_total"] = missing_in_total
            observation["missing_created_note"] = missing_note
        share_counted, share_note, share_text = counted_share(agg) if agg is not None else (None, None, None)
        if share_text:
            observation["partial"] = share_text
            if share_counted is not None:
                observation["counted"] = share_counted
        basis = "exact" if exact else "sample"
        caption = f"{fmt_int(count)} {'case' if count == 1 else 'cases'} · {'exact' if exact else 'at least'} · {window.label}"
        items = [case_list_item(c, prefs) for c in page[:_CASE_LIST_MAX]]
        artifacts = [Artifact(
            id="a1", kind="case_list", title="Matching cases", title_trusted=True,
            data={"items": items}, provenance="code", untrusted_labels=True,
            basis=basis, total=count, truncated=count > len(items), window=caption,
        )]
        if breakdown_known and (by_verdict or by_status):
            # Canonical order (the lifecycle; true positive, false positive, needs human),
            # never by volume (Round 12 SPEC §7.2 decision 27).
            if args.verdict:
                pairs = [(_STATUS_LABELS.get(k, k), v) for k, v in _in_order(by_status, _STATUS_ORDER)]
                title, dim = "Matching cases by status", "Status"
            else:
                pairs = [(_VERDICT_LABELS.get(k, "No verdict" if k == "none" else k), v)
                         for k, v in _in_order(by_verdict, _VERDICT_ORDER)]
                title, dim = "Matching cases by verdict", "Verdict"
            artifacts.append(Artifact(
                id="a2", kind="categories", title=title, title_trusted=True,
                data=categories(pairs, dimension=dim, ordered=True), provenance="code",
                basis=basis, total=count, window=caption,
            ))
        artifacts.append(Artifact(
            id=f"a{len(artifacts) + 1}", kind="kpis", title="Key figures", title_trusted=True,
            data={"items": [
                kpi("matched", "Matching cases", count, bound=not exact),
                kpi("open", "Still open", open_count, bound=open_count is not None and not open_exact,
                    context=None if open_count is not None else "not counted"),
                kpi("avg_risk", "Average risk", round(avg_risk, 1) if avg_risk is not None else None, "score"),
            ]},
            provenance="code", basis=basis, total=count, window=caption,
        ))
        noun = "cases" if count != 1 else "case"
        summary = f"{fmt_int(count)} {noun} matched" if exact else f"at least {fmt_int(count)} {noun} matched"
        summary += f" ({window.label})"
        if count > len(page):
            summary += f"; listing the {fmt_int(len(page))} {_sort_phrase(args.sort_field, args.sort_order)}"
        if window.clamped:
            summary += "; window limited to the selected range"
        notes: list[str] = []
        if not exact:
            notes.append(f"newest {fmt_int(scanned)} cases scanned" if scanned is not None and agg is None
                         else share_note or "partial: the case store stopped answering during the count")
        elif unlisted > 0 and scanned is not None:
            notes.append(f"rows come from the newest {fmt_int(scanned)} cases; {fmt_int(unlisted)} matches "
                         "are older and not listed")
        if missing and not missing_in_total and missing_note:
            notes.append(missing_note)
        coverage = "; ".join(notes) or None
        return ToolOutcome(
            ok=True, summary=summary,
            untrusted_params={k: str(v) for k, v in args.filters().items() if k in ("text", "entity", "assignee", "rule")},
            observation=observation, artifacts=artifacts, rows=count,
            basis=basis, coverage=coverage,
        )


# --------------------------------------------------------------------------- #
# get_case
# --------------------------------------------------------------------------- #
GET_CASE_SECTIONS = ("summary", "evidence", "timeline", "decision", "mitre", "runbook", "rationale", "campaign")
#: What ``get_case`` reads when the call names no section. ``runbook`` (Round 14 SPEC
#: §4.10.10) is one per-case document read, so "what is next on this case" is answered
#: from any case read.
GET_CASE_DEFAULT_SECTIONS = ("summary", "evidence", "timeline", "decision", "mitre", "runbook")


class GetCaseInput(ToolInput):
    case_id: str | None = Field(default=None, max_length=128)
    include: list[Literal[GET_CASE_SECTIONS]] = Field(  # type: ignore[valid-type]
        default_factory=lambda: list(GET_CASE_DEFAULT_SECTIONS), max_length=len(GET_CASE_SECTIONS),
    )

    @field_validator("case_id", mode="before")
    @classmethod
    def _blank(cls, value: Any) -> Any:
        return none_if_blank(value)

    @field_validator("include", mode="before")
    @classmethod
    def _include(cls, value: Any) -> Any:
        if value in (None, "", []):
            return list(GET_CASE_DEFAULT_SECTIONS)
        if isinstance(value, str):
            value = [value]
        if isinstance(value, list):
            out = []
            for item in value:
                key = str(item).strip().lower()
                key = {"why": "rationale", "history": "timeline", "attack": "mitre", "runbooks": "runbook",
                       "run": "runbook", "progress": "runbook", "next_step": "runbook"}.get(key, key)
                if key in GET_CASE_SECTIONS and key not in out:
                    out.append(key)
            return out or ["summary"]
        return value


async def find_case(ctx: ChatToolContext, case_id: str) -> Any:
    """A case by id, or by its display ``case_number`` (case-insensitive)."""
    try:
        case = await ctx.cases.get(case_id)
    except Exception as exc:  # noqa: BLE001
        logger.warning("case lookup failed: %s", exc)
        case = None
    if case is not None:
        return case
    wanted = case_id.strip().lower()
    cases, _total, _ok = await load_case_page(ctx)
    return next(
        (c for c in cases if wanted in {str(c.case_id).lower(), str(c.case_number or "").lower()}),
        None,
    )


def progress_text(progress: Any) -> str:
    """A run's progress as the Console's chip reads it (Round 14 SPEC §4.10.7): "4/11"
    (done over total), with "· 1 blocked" and "· 1 waiting" when steps are blocked or
    wait for an approval."""
    def _n(name: str) -> int:
        value = progress.get(name) if isinstance(progress, dict) else getattr(progress, name, 0)
        return int(value or 0)

    out = f"{_n('done'):,}/{_n('total'):,}"
    if _n("blocked"):
        out += f" · {_n('blocked'):,} blocked"
    if _n("waiting"):
        out += f" · {_n('waiting'):,} waiting"
    return out


def _last_decision_reason(case: Any) -> str | None:
    for entry in reversed(list(case.status_history or [])):
        if str(getattr(entry, "by", "")) in ("agent", "system", "analyst_policy"):
            return opt_text(getattr(entry, "reason", ""), 300)
    return None


class GetCaseTool(ChatTool):
    name: ClassVar[str] = "get_case"
    label: ClassVar[str] = "Read a case"
    running_label: ClassVar[str] = "Reading a case"
    scope: ClassVar[str] = "cases"
    requires: ClassVar[tuple[tuple[str, str], ...]] = (("cases", "read"),)
    optional_grants: ClassVar[tuple[tuple[str, str], ...]] = (("cost", "view"), ("runbooks", "read"))
    data_source: ClassVar[str] = "Case store, runbook runs and audit trail"
    signature: ClassVar[str] = (
        "get_case(case_id?, include?=[summary,evidence,timeline,decision,mitre,runbook] (+rationale, campaign)) "
        "-- one case: verdict, risk, evidence summaries, status timeline and the recorded decision"
    )
    display_keys: ClassVar[tuple[str, ...]] = ("case_id", "include")

    def display_params(self, inp: dict[str, Any]) -> dict[str, Any]:
        params = dict(inp) if isinstance(inp, dict) else {}
        if isinstance(params.get("include"), list):
            params["include"] = ",".join(str(i) for i in params["include"][:len(GET_CASE_SECTIONS)])
        return super().display_params(params)

    async def run(self, ctx: ChatToolContext, **inp: Any) -> ToolOutcome:
        args, error = parse_input(GetCaseInput, inp)
        if error is not None:
            return error
        case_id = args.case_id or ctx.case_id
        if not case_id:
            return ToolOutcome.failure("Invalid input: check case_id")
        if ctx.cases is None:
            return ToolOutcome.failure("The case store is not available")
        case = await find_case(ctx, case_id)
        if case is None:
            return ToolOutcome.failure("Case not found", summary="Case not found")
        prefs = ctx.prefs
        include = set(args.include)
        row = case_row(case, prefs)
        observation: dict[str, Any] = {"case": row}
        if "summary" in include:
            row.update({
                "summary": opt_text(case.summary, 600),
                "recommended_action": opt_text(case.recommended_action, 300),
                "disposition": enum_value(case.disposition),
                "updated_at": iso_or_none(case.updated_at),
                "campaign_id": opt_text(case.campaign_id, 128),
                "detection_source": opt_text(case.detection_source, 40),
                "evidence_items": len(case.evidence or []),
                "member_events": len(case.member_event_ids or []),
            })
        if "evidence" in include:
            observation["evidence"] = [
                {"summary": text(e.summary, 300)} for e in list(case.evidence or [])[:5]
            ]
        history = list(case.status_history or [])
        if "timeline" in include:
            observation["timeline"] = [
                {"at": iso_or_none(h.at), "from": h.from_status or None, "to": h.to_status,
                 "by": text(h.by, 60), "reason": opt_text(h.reason, 200)}
                for h in history[-10:]
            ]
        if "decision" in include:
            observation["decision"] = {
                "status": enum_value(case.status),
                "decision_by": enum_value(case.decision_by),
                "objection_window_expires_at": iso_or_none(case.objection_window_expires_at),
                "last_decision_reason": _last_decision_reason(case),
            }
        technique_rows: list[dict[str, Any]] = []
        if "mitre" in include and case.mitre:
            from ...engine import mitre as mitre_corpus

            for tid in case.mitre[:20]:
                meta = mitre_corpus.technique(tid)
                if meta is None:
                    continue
                tactics = meta.get("tactics") or []
                technique_rows.append({
                    "id": meta["id"], "name": str(meta.get("name") or "")[:120],
                    "tactic": str(tactics[0]) if tactics else None,
                })
            observation["mitre"] = technique_rows
        runbook_runs: list[dict[str, Any]] = []
        if "runbook" in include:
            observation["runbook"] = await self._runbook(ctx, case)
            runbook_runs = list(observation["runbook"].get("runs") or [])
        if "rationale" in include and ctx.audit is not None:
            observation["rationale"] = await self._rationale(ctx, case)
        if "campaign" in include and case.campaign_id and ctx.campaigns is not None:
            try:
                campaign = await ctx.campaigns.get(case.campaign_id)
            except Exception:  # noqa: BLE001
                campaign = None
            if campaign is not None:
                observation["campaign"] = {
                    "id": text(campaign.id, 128), "name": opt_text(campaign.name, 120),
                    "status": enum_value(campaign.status), "case_count": len(campaign.case_ids),
                }
        related = await self._related(ctx, case)
        artifacts = self._artifacts(ctx, case, technique_rows, history, related, runbook_runs)
        verdict = enum_value(case.verdict) or "no verdict"
        status = enum_value(case.status) or "unknown"
        summary = (
            f"Case read: status {status}, verdict {verdict}, risk {fmt_int(case.risk_score)}"
            f", {len(case.evidence or [])} evidence {'item' if len(case.evidence or []) == 1 else 'items'}"
        )
        citation = None
        try:
            citation = Citation(
                id=citation_id("C", 1, ctx), kind="case", title=case.title or case.case_id,
                case_id=case.case_id, untrusted=True,
            )
        except Exception:  # noqa: BLE001 — an unusual case id simply is not citable
            citation = None
        return ToolOutcome(
            ok=True, summary=summary, untrusted_params={"case_id": str(case_id)[:128]},
            observation=observation, artifacts=artifacts, rows=1, basis="exact",
            citations=[citation] if citation else [],
        )

    async def _rationale(self, ctx: ChatToolContext, case: Any) -> dict[str, Any]:
        """The "why" of the latest run as a WHITELIST of engine-derived fields.

        ``build_rationale`` also returns audit payloads that must never reach a model
        (SPEC §5.3: ``prompt_excerpt``, ``tool_input`` and ``tool_output_summary``):
        ``tools[].summary`` IS the tool output summary (which can hold raw exception
        text, §5.2) and ``knowledge[].snippet`` comes from the CONTEXT row's
        ``tool_input`` (imported intel and precedent text). Only tool names and call
        counts, the native queries bounded like ``audit_search`` does, knowledge
        source labels, the persona id, the runbook that guided the run (its id and
        version; Round 14) and the legacy playbook id of an earlier run, the
        deterministic case-manager rationale and a bounded reasoning excerpt are
        projected; the engine fences the whole observation. The runbook's selection
        reason and match explanation are never projected: they quote rule names and
        other values that come from logs (#9)."""
        from ...engine.case_rationale import build_rationale

        try:
            rows = await ctx.audit.records_for_case(case.case_id, 500)
            data = build_rationale(case.case_id, case, rows)
        except Exception as exc:  # noqa: BLE001 — explainability degrades, never fails
            logger.info("rationale unavailable for chat: %s", exc)
            return {"available": False}
        calls: Counter[str] = Counter()
        queries: list[str] = []
        for entry in data.get("tools") or []:
            if not isinstance(entry, dict):
                continue
            calls[text(entry.get("tool"), 60) or "tool"] += 1
            query = opt_text(entry.get("query"), _RATIONALE_QUERY_CHARS)
            if query and query not in queries and len(queries) < 3:
                queries.append(query)
        knowledge_sources: Counter[str] = Counter(
            text(k.get("source"), 60) or "unknown"
            for k in (data.get("knowledge") or []) if isinstance(k, dict)
        )
        persona = data.get("persona") if isinstance(data.get("persona"), str) else ""
        playbook = data.get("playbook") if isinstance(data.get("playbook"), dict) else {}
        runbook = data.get("runbook") if isinstance(data.get("runbook"), dict) else {}
        runbook_version = runbook.get("version")
        return {
            "available": True,
            "tool_calls": [{"tool": name, "calls": n} for name, n in sorted(calls.items())][:10],
            "queries": queries,
            "knowledge_sources": dict(knowledge_sources.most_common(5)),
            "reasoning": opt_text(data.get("reasoning"), 600),
            # Engine-authored by case_manager (verdict enum, numbers, policy values).
            "decision_rationale": opt_text(data.get("decision_rationale"), 400),
            "persona": opt_text(persona, 60),
            # Round 14: set only when the runbook's guidance reached the investigator.
            "runbook": opt_text(runbook.get("id"), 64),
            "runbook_version": (
                runbook_version
                if isinstance(runbook_version, int) and not isinstance(runbook_version, bool)
                else None
            ),
            # Runs before Round 14 recorded their procedure here.
            "playbook": opt_text(playbook.get("id"), 60),
        }

    async def _runbook(self, ctx: ChatToolContext, case: Any) -> dict[str, Any]:
        """The case's runbook runs as Case chat may read them (Round 14 SPEC
        §4.10.10): per run that is not abandoned, its title, version, status, progress,
        the next step's title and the required steps still open (``run_summary``),
        plus the titles of those open steps (at most five). No lookup result is
        included, so no raw log row can reach a prompt (#7); the engine fences the
        whole observation (#9). It needs ``runbooks:read`` beside ``cases:read``, like
        the case runbook route, and reads as not available without it, without a run
        store, or when the store cannot be read (never as "no runbook")."""
        if not ctx.has("runbooks", "read"):
            return {"available": False, "reason": "no access to runbooks"}
        store = getattr(ctx, "runbook_runs", None)
        if store is None:
            return {"available": False, "reason": "runbook runs are not available here"}
        from ...engine.runbook_runs import next_step, ordered_steps, run_summary

        try:
            case_runs = await store.get(str(case.case_id))
        except Exception as exc:  # noqa: BLE001 -- explainability degrades, never fails
            logger.info("runbook runs unavailable for chat: %s", exc)
            return {"available": False, "reason": "the runbook runs could not be read"}
        live = [run for run in case_runs.runs if run.status != "abandoned"]
        summaries = run_summary(live)
        runs: list[dict[str, Any]] = []
        for run, summary in zip(live, summaries):
            progress = summary.get("progress") or {}
            nxt = next_step(run)
            open_titles = [
                text(step.title, 160)
                for step in ordered_steps(run.snapshot)
                if step.required and getattr(run.steps.get(step.id), "status", "todo") not in ("done", "not_applicable")
            ][:5]
            runs.append({
                "title": text(summary.get("title"), 120),
                "version": summary.get("version"),
                "status": summary.get("status"),
                "attached_by": run.attached_by,
                "progress": progress_text(progress),
                "done": progress.get("done"),
                "total": progress.get("total"),
                "not_applicable": progress.get("not_applicable"),
                "blocked": progress.get("blocked"),
                "waiting_for_approval": progress.get("waiting"),
                "required_open": summary.get("required_open"),
                "next_step": opt_text(summary.get("next_step"), 160),
                "next_step_phase": PHASE_LABELS.get(nxt.phase, nxt.phase) if nxt is not None else None,
                "open_required_steps": open_titles,
            })
        return {"available": True, "runs": runs}

    async def _related(self, ctx: ChatToolContext, case: Any) -> list[dict[str, Any]]:
        """The entity card's related cases (at most 5): each named by its display number
        and title when the store has it (one bounded read per case). The internal id is
        only the link target, never the visible name (Round 14 F7): a case without a
        title, or one that could not be read, gets a fixed Console name instead."""
        out: list[dict[str, Any]] = []
        for cid in list(case.related_case_ids or [])[:5]:
            other = None
            failed = False
            try:
                other = await ctx.cases.get(str(cid))
            except Exception as exc:  # noqa: BLE001 -- the link still opens it
                failed = True
                logger.info("related case read failed: %s", exc)
            out.append({
                "case_id": str(cid),
                "case_number": opt_text(getattr(other, "case_number", ""), 64) if other is not None else None,
                "title": related_case_title(other, failed=failed),
            })
        return out

    def _artifacts(self, ctx: ChatToolContext, case: Any, techniques: list[dict[str, Any]], history: list[Any],
                   related: list[dict[str, Any]] | None = None,
                   runbook_runs: list[dict[str, Any]] | None = None) -> list[Artifact]:
        artifacts: list[Artifact] = []
        entity_type = enum_value(getattr(case.entity, "type", None)) or ""
        kind = _ENTITY_KIND.get(entity_type)
        # Facts are prose captions (BLOCKS.md rule 22): enum values as the console
        # labels them, never internal constants. The verdict is the card's own badge,
        # so it is a fact row only when there is no verdict to badge.
        # Round 14 (F7): a case is named by its number, never its internal id; a case
        # stored before numbering is named by its title (source-derived, untrusted).
        named = (
            {"label": "Case", "value": str(case.case_number)} if case.case_number
            else {"label": "Case", "value": display(case.title or "Untitled case"), "untrusted": True}
        )
        facts = [
            named,
            {"label": "Status", "value": _label(_STATUS_LABELS, case.status, "Unknown")},
        ]
        if verdict_semantic(case.verdict) is None:
            facts.append({"label": "Verdict", "value": _label(_VERDICT_LABELS, case.verdict, "No verdict yet")})
        facts.append({"label": "Decided by", "value": _label(_DECIDED_BY_LABELS, case.decision_by, "Not decided")})
        if case.rule_ids:
            facts.append({"label": "Rules", "value": ", ".join(str(r) for r in case.rule_ids[:5]), "untrusted": True})
        if case.source_name or case.source_id:
            facts.append({"label": "Source", "value": str(case.source_name or case.source_id), "untrusted": True})
        if case.assignee:
            facts.append({"label": "Assignee", "value": str(case.assignee), "untrusted": True})
        for run in (runbook_runs or [])[:2]:
            # Round 14: the runbook on the case and how far it is ("4/11").
            facts.append({"label": "Runbook", "value": f"{run['title']} v{run['version']} · {run['progress']}"})
        if kind:
            artifacts.append(Artifact(
                id="a1", kind="entity", title="Case entity", title_trusted=True,
                data={
                    "entity": {"kind": kind, "value": str(case.entity.value)},
                    "risk": finite(case.risk_score),
                    "verdict": verdict_semantic(case.verdict),
                    "facts": facts,
                    "related_cases": related if related is not None else [
                        {"case_id": str(cid), "title": RELATED_CASE_UNREAD}
                        for cid in list(case.related_case_ids or [])[:5]
                    ],
                    "first_seen": iso_or_none(case.created_at),
                    "last_seen": iso_or_none(case.updated_at),
                },
                provenance="code", untrusted_labels=True,
            ))
        if history:
            artifacts.append(Artifact(
                id=f"a{len(artifacts) + 1}", kind="timeline", title="Status history", title_trusted=True,
                # Round 14 (F7): the move and its reason in plain words ("Open to
                # Escalated", "Automatic close of a confirmed threat is off (by the
                # system)"); an analyst's own reason stays as written.
                data={"events": [
                    {"at": iso_or_none(h.at), "label": status_change_label(h.from_status, h.to_status),
                     "detail": opt_text(status_change_detail(h.by, h.reason), 500),
                     "kind": "action", "semantic": h.to_status if h.to_status in (
                         "new", "investigating", "escalated", "on_hold", "resolved", "closed") else None}
                    for h in history[-50:] if iso_or_none(h.at)
                ]},
                provenance="code", untrusted_labels=True, total=len(history), truncated=len(history) > 50,
            ))
        items = [
            kpi("risk", "Risk score", case.risk_score, "score", display="gauge"),
            kpi("confidence", "Confidence", (finite(case.confidence) or 0) * 100 if finite(case.confidence) is not None else None, "percent"),
            kpi("evidence", "Evidence items", len(case.evidence or [])),
            kpi("events", "Member events", len(case.member_event_ids or [])),
        ]
        if ctx.has("cost", "view"):
            items.append(kpi("token_cost", "AI cost", finite(case.token_cost), "usd"))
        artifacts.append(Artifact(
            id=f"a{len(artifacts) + 1}", kind="kpis", title="Case figures", title_trusted=True,
            data={"items": items}, provenance="code",
        ))
        if techniques:
            artifacts.append(Artifact(
                id=f"a{len(artifacts) + 1}", kind="mitre", title="ATT&CK techniques", title_trusted=True,
                data={"techniques": techniques}, provenance="code",
            ))
        return artifacts


# --------------------------------------------------------------------------- #
# shift_report
# --------------------------------------------------------------------------- #
class ShiftReportInput(ToolInput):
    window_hours: int | None = Field(default=None, ge=1, le=168)
    attention_limit: int = Field(default=10, ge=1, le=25)

    @field_validator("window_hours", mode="before")
    @classmethod
    def _blank(cls, value: Any) -> Any:
        return none_if_blank(value)


# The shift headline's "Needs human" counts the open cases whose VERDICT is Needs
# human, the badge the Needs attention list beside it shows, so the two agree (Round 13
# close: a STATUS count of 0 sat beside ten "Needs human" badges). The Standup page's
# "Needs human" tile shows the same verdict figure; the legacy ``needs_human`` STATUS
# count is its "Awaiting analyst" tile, which chat does not show, and the workload rows
# carry it as ``awaiting_analyst`` so no figure here reads as a second "needs human".
#: A related case's visible name when the card has nothing better (Round 14 F7: the
#: internal ``case-...`` id is the link target, never the name shown).
RELATED_CASE_UNTITLED = "Untitled case"
RELATED_CASE_UNREAD = "Related case"
RELATED_CASE_UNREADABLE = "Related case, not readable"
RELATED_CASE_GONE = "Related case, not found"


def related_case_title(other: Any, *, failed: bool = False) -> str:
    """A related case's visible name: its title (source-derived, shown with invisible
    characters made visible), else a fixed Console name saying why there is none."""
    if failed:
        return RELATED_CASE_UNREADABLE
    if other is None:
        return RELATED_CASE_GONE
    title = display(getattr(other, "title", "") or "")
    return title or RELATED_CASE_UNTITLED


# Console display labels for the case enums an entity card states as facts. Status
# names come from the ONE shared table (Round 14, D25), which the Status history moves
# read too: ``needs_human`` is the legacy alias of "Open · awaiting analyst", as the
# console's status badge says.
_STATUS_LABELS = CASE_STATUS_WORDS
_VERDICT_LABELS = {"TRUE_POSITIVE": "True positive", "FALSE_POSITIVE": "False positive", "NEEDS_HUMAN": "Needs human"}
_DECIDED_BY_LABELS = {
    "agent": "Agent", "analyst": "Analyst", "system": "System", "analyst_policy": "Analyst policy",
}


_STATUS_ORDER = ("new", "open", "needs_human", "investigating", "escalated", "on_hold", "resolved", "closed")
_VERDICT_ORDER = ("TRUE_POSITIVE", "FALSE_POSITIVE", "NEEDS_HUMAN")


def _in_order(counts: dict[str, int], order: tuple[str, ...]) -> list[tuple[str, int]]:
    """``counts`` in ``order``; values outside it follow, by volume then name."""
    rank = {k: i for i, k in enumerate(order)}
    return sorted(counts.items(), key=lambda kv: (rank.get(kv[0], len(order)), -kv[1], kv[0]))


def _label(labels: dict[str, str], value: Any, missing: str) -> str:
    """``value``'s display label; an unknown value humanised, never the raw token."""
    raw = enum_value(value)
    if not raw:
        return missing
    return labels.get(raw) or display(raw.replace("_", " ").strip().capitalize()) or missing


_HEADLINE_LABELS = {
    "open": "Open cases", "escalated": "Escalated", "needs_human_verdict": "Needs human",
    "unassigned": "Unassigned", "sla_breached": "SLA breached",
}


#: SLA rows the shift snapshot lists per kind (overdue, close to target); the totals
#: count every one.
_SLA_ROWS = 5


def _sla_ref(row: dict[str, Any]) -> dict[str, Any]:
    """A shift SLA row's case: its id and, when it has one, its display number."""
    case_id = text(row.get("case_id"), 128)
    shown = opt_text(row.get("display_id"), 64)
    return {"case_id": case_id, "case_number": shown if shown and shown != case_id else None}


def _minutes_left(row: dict[str, Any]) -> float | None:
    target, age = finite(row.get("target_minutes")), finite(row.get("age_minutes"))
    return round(max(0.0, target - age), 1) if target is not None and age is not None else None


def _nearest_first(rows: Any) -> list[dict[str, Any]]:
    """Close-to-target rows, the least time left first (ties by case id)."""
    kept = [r for r in (rows or []) if isinstance(r, dict)]
    return sorted(kept, key=lambda r: (_minutes_left(r) if _minutes_left(r) is not None else math.inf,
                                       str(r.get("case_id") or "")))


class ShiftReportTool(ChatTool):
    name: ClassVar[str] = "shift_report"
    label: ClassVar[str] = "Built the shift snapshot"
    running_label: ClassVar[str] = "Building the shift snapshot"
    scope: ClassVar[str] = "cases"
    requires: ClassVar[tuple[tuple[str, str], ...]] = (("cases", "read"),)
    data_source: ClassVar[str] = "Open cases and shift handoff"
    signature: ClassVar[str] = (
        "shift_report(window_hours?, attention_limit?=10) -- deterministic shift snapshot: what needs "
        "attention, SLA aging, workload, changes since the prior window, open action items (you write the prose)"
    )
    display_keys: ClassVar[tuple[str, ...]] = ("window_hours", "attention_limit")

    async def run(self, ctx: ChatToolContext, **inp: Any) -> ToolOutcome:
        args, error = parse_input(ShiftReportInput, inp)
        if error is not None:
            return error
        if ctx.standup is None or not hasattr(ctx.standup, "shift_snapshot"):
            return ToolOutcome.failure("The shift report is not available")
        window = resolve_window(ctx, window_hours=args.window_hours, default_hours=24)
        if isinstance(window, str):
            return ToolOutcome.failure(window)
        if not window.trailing:
            # The snapshot is "the queue now" counted back from now: under a past
            # range it would read outside the selection (§4.8.4) and mislabel it.
            return ToolOutcome.failure(
                "The shift snapshot covers the hours up to now; the selected range ends in the past"
            )
        # Whole hours, never wider than asked, at most a week (the snapshot's bound).
        hours = min(168, max(1, math.floor(window.span_hours + 1e-6)))
        notes = []
        if window.span_hours > 168 + 1e-6:
            notes.append("the shift snapshot covers at most the last 7 days")
        elif abs(window.span_hours - hours) > 1e-6:
            notes.append("the range was narrowed to whole hours")
        try:
            # The headline's "Needs human" counts verdicts (Round 13 close); a standup
            # service without that option (an older one) still gives the snapshot.
            if "needs_human_verdict" in inspect.signature(ctx.standup.shift_snapshot).parameters:
                snap = await ctx.standup.shift_snapshot(ctx.prefs, window_hours=hours, needs_human_verdict=True)
            else:
                snap = await ctx.standup.shift_snapshot(ctx.prefs, window_hours=hours)
        except Exception as exc:  # noqa: BLE001
            logger.warning("shift snapshot failed: %s", exc)
            return ToolOutcome.failure("The shift report could not be built")
        snap = snap if isinstance(snap, dict) else {}
        headline = snap.get("headline_counts") or {}
        deltas = snap.get("deltas") or {}
        queue = [q for q in (snap.get("attention_queue") or []) if isinstance(q, dict)]
        sla = snap.get("sla_aging") or {}
        workload = [w for w in (snap.get("workload") or []) if isinstance(w, dict)]
        actions = [a for a in (snap.get("action_items") or []) if isinstance(a, dict)]
        limit = args.attention_limit
        # The Round 12 window words every other caption uses ("last 24 hours"), so a
        # report lists the shift's window once, never "last 24h; last 24 hours".
        window_words = humanise_relative_window(hours, "h")
        observation = {
            "window": window_words,
            "headline": {k: headline.get(k) for k in _HEADLINE_LABELS},
            "changes_vs_prior_window": {
                k: {"current": (deltas.get(k) or {}).get("current"), "prior": (deltas.get(k) or {}).get("prior"),
                    "delta": (deltas.get(k) or {}).get("delta")}
                for k in _HEADLINE_LABELS if isinstance(deltas.get(k), dict)
            },
            "attention": [
                {"case_id": text(q.get("case_id"), 128), "case_number": opt_text(q.get("case_number"), 64),
                 "title": text(q.get("title"), 160),
                 "status": q.get("status"), "verdict": q.get("verdict"),
                 "risk_score": finite(q.get("risk_score")), "severity": q.get("severity_band"),
                 "age_minutes": finite(q.get("age_minutes")), "assignee": opt_text(q.get("assignee"), 80)}
                for q in queue[:limit]
            ],
            "sla": {
                "enabled": bool(sla.get("enabled")),
                "totals": (sla.get("totals") or {}),
                "breached": [
                    {**_sla_ref(b), "overdue_minutes": finite(b.get("overdue_minutes")),
                     "assignee": opt_text(b.get("assignee"), 80)}
                    for b in [r for r in (sla.get("breached") or []) if isinstance(r, dict)][:_SLA_ROWS]
                ],
                # Round 13 polish: the open cases close to their response target, nearest
                # first, bounded like the overdue list (the totals count every one).
                "about_to_breach": [
                    {**_sla_ref(b), "minutes_left": _minutes_left(b), "target_minutes": finite(b.get("target_minutes")),
                     "assignee": opt_text(b.get("assignee"), 80)}
                    for b in _nearest_first(sla.get("about_to_breach"))[:_SLA_ROWS]
                ],
            },
            "workload": [
                {"analyst": text(w.get("analyst"), 80), "open": w.get("open"),
                 "escalated": w.get("escalated"), "awaiting_analyst": w.get("needs_human")}
                for w in workload[:10]
            ],
            "open_action_items": [
                {"title": text(a.get("title"), 200), "status": text(a.get("status"), 20),
                 "owner": opt_text(a.get("owner"), 80)}
                for a in actions[:5]
            ],
        }
        items = []
        for key, label in _HEADLINE_LABELS.items():
            delta = deltas.get(key) if isinstance(deltas.get(key), dict) else None
            items.append(kpi(
                key, label, headline.get(key),
                delta=({"value": finite(delta.get("delta")) or 0, "period_label": PREVIOUS_WINDOW_LABEL,
                        "good_direction": "down"} if delta and finite(delta.get("delta")) is not None else None),
            ))
        artifacts = [Artifact(
            id="a1", kind="kpis", title="Shift headline", title_trusted=True,
            data={"items": items}, provenance="code", window=window_words,
        )]
        artifacts.append(Artifact(
            id="a2", kind="case_list", title="Needs attention", title_trusted=True,
            data={"items": [
                {"case_id": str(q.get("case_id") or ""), "case_number": opt_text(q.get("case_number"), 64),
                 "title": display(q.get("title") or q.get("case_id")),
                 "severity": q.get("severity_band") if q.get("severity_band") in ("critical", "high", "medium", "low", "info") else None,
                 "verdict": verdict_semantic(q.get("verdict")), "status": q.get("status"),
                 "risk": finite(q.get("risk_score"))}
                for q in queue[:min(limit, _CASE_LIST_MAX)] if q.get("case_id")
            ]},
            provenance="code", untrusted_labels=True, total=len(queue), truncated=len(queue) > limit,
        ))
        if workload:
            artifacts.append(Artifact(
                id="a3", kind="categories", title="Open cases by analyst", title_trusted=True,
                data=categories([(w.get("analyst"), w.get("open")) for w in workload], dimension="analyst"),
                provenance="code", untrusted_labels=True,
            ))
        if actions:
            artifacts.append(Artifact(
                id=f"a{len(artifacts) + 1}", kind="table", title="Open action items", title_trusted=True,
                data={"columns": [column("title", "Action", untrusted=True), column("status", "Status"),
                                  column("owner", "Owner", untrusted=True)],
                      "rows": [[a.get("title"), a.get("status"), a.get("owner")] for a in actions[:25]]},
                provenance="code", untrusted_labels=True, total=len(actions), truncated=len(actions) > 25,
            ))
        summary = (
            f"Shift snapshot ({window_words}): {fmt_int(headline.get('open'))} open, {fmt_int(headline.get('escalated'))} escalated, "
            f"{fmt_int(headline.get('unassigned'))} unassigned, {fmt_int(headline.get('sla_breached'))} past SLA"
        )
        return ToolOutcome(ok=True, summary=summary, observation=observation, artifacts=artifacts,
                           rows=len(queue), basis="exact", coverage="; ".join(notes) or None)


def display(value: Any) -> str:
    from ..blocks import display_text

    return display_text(value, 120)


# --------------------------------------------------------------------------- #
# list_campaigns
# --------------------------------------------------------------------------- #
class ListCampaignsInput(ToolInput):
    status: Literal["open", "monitoring", "resolved"] | None = None
    campaign_id: str | None = Field(default=None, max_length=128)
    #: The campaigns that hold this case (its id or display number), so a question
    #: about "the campaign that includes CASE-000046" finds that campaign now, whatever
    #: newer campaigns exist and whatever id it has after growing (polish round PB4).
    case_id: str | None = Field(default=None, max_length=128)
    #: The campaigns that involve this entity value (a user, host or IP): one of their
    #: shared entities has it, or one of their cases is about it, so an investigation
    #: of the entity lists only its own campaigns (Round 13 close).
    entity: str | None = Field(default=None, max_length=256)
    limit: int = Field(default=10, ge=1, le=25)

    @field_validator("status", "campaign_id", "case_id", "entity", mode="before")
    @classmethod
    def _blank(cls, value: Any) -> Any:
        value = none_if_blank(value)
        return value.strip().lower() if isinstance(value, str) and value.strip().lower() in ("open", "monitoring", "resolved") else value


class ListCampaignsTool(ChatTool):
    name: ClassVar[str] = "list_campaigns"
    label: ClassVar[str] = "Listed campaigns"
    running_label: ClassVar[str] = "Listing campaigns"
    scope: ClassVar[str] = "cases"
    requires: ClassVar[tuple[tuple[str, str], ...]] = (("cases", "read"),)
    data_source: ClassVar[str] = "Campaign correlation"
    signature: ClassVar[str] = (
        "list_campaigns(status?=open|monitoring|resolved, campaign_id?, case_id?, entity?, limit?=10) -- "
        "campaigns, latest first: cases sharing entities and ATT&CK techniques"
    )
    display_keys: ClassVar[tuple[str, ...]] = ("status", "campaign_id", "case_id", "entity", "limit")

    async def run(self, ctx: ChatToolContext, **inp: Any) -> ToolOutcome:
        args, error = parse_input(ListCampaignsInput, inp)
        if error is not None:
            return error
        if ctx.campaigns is None:
            return ToolOutcome.failure("Campaign correlation is not available")
        from ...engine.views import campaign_json

        member: Any = None
        if args.case_id:
            member = await find_case(ctx, args.case_id)
        matches: dict[int, str] = {}
        entity_cases = read = 0
        try:
            if args.campaign_id:
                one = await ctx.campaigns.get(args.campaign_id)
                campaigns, total = ([one], 1) if one is not None else ([], 0)
            elif args.case_id:
                # The campaigns that hold the case now (status filter applied), most
                # recently active first; none when the case is not found.
                held: list[Any] = []
                if member is not None:
                    every, _total = await ctx.campaigns.list(status=args.status)
                    held = [c for c in every if member.case_id in (c.case_ids or [])]
                campaigns, total = held[:args.limit], len(held)
            elif args.entity:
                # The campaigns that involve the entity, most recently active first: a
                # shared entity with that value, or a member case about it.
                every, _total = await ctx.campaigns.list(status=args.status)
                about, entity_cases, read = await _cases_about(ctx, args.entity)
                involved = [(c, _involvement(c, args.entity, about)) for c in every]
                kept = [(c, how) for c, how in involved if how]
                matches = {id(c): str(how) for c, how in kept}
                campaigns, total = [c for c, _how in kept][:args.limit], len(kept)
            else:
                campaigns, total = await ctx.campaigns.list(status=args.status, limit=args.limit)
        except Exception as exc:  # noqa: BLE001
            logger.warning("list_campaigns failed: %s", exc)
            return ToolOutcome.failure("The campaign store did not answer")
        rows = [campaign_json(c) for c in campaigns]
        if args.entity and not args.campaign_id and not args.case_id:
            for row, campaign in zip(rows, campaigns):
                row["match"] = matches.get(id(campaign))
        numbers = await _case_numbers(ctx, [c for r in rows for c in r["case_ids"][:5]])

        def member_numbers(ids: list[Any]) -> dict[str, Any]:
            # Each listed member's display number beside its id (Round 13 A8), so an
            # answer names the cases as the analyst knows them; omitted when none has one.
            shown = [numbers.get(str(c)) for c in ids[:5]]
            return {"case_numbers": shown} if any(shown) else {}

        case_filter: dict[str, Any] = {}
        if args.entity and not args.campaign_id and not args.case_id:
            # How the involvement was found (the value itself is the analyst's, never
            # echoed): the cases about the entity that were checked against the members.
            case_filter = {"entity_filter": {"cases_about_entity": entity_cases, "cases_checked": read}}
        if args.case_id:
            # Which case the listing is about, as the analyst knows it (its number),
            # and whether it was found at all ("no campaign holds it" vs "no such case").
            case_filter = {"case_filter": {
                "found": member is not None,
                "case_id": text(member.case_id, 128) if member is not None else None,
                "case_number": opt_text(getattr(member, "case_number", None), 64) if member is not None else None,
            }}
        observation = {
            "status_filter": args.status,
            **case_filter,
            "total": total,
            "returned": len(rows),
            "campaigns": [
                {"id": text(r["id"], 128), "name": opt_text(r["name"], 120), "status": r["status"],
                 "case_count": r["case_count"], "case_ids": [text(c, 128) for c in r["case_ids"][:5]],
                 **member_numbers(r["case_ids"]),
                 "entities": [f"{text(e['entity_type'], 20)}:{text(e['value'], 120)}"
                              for e in r["entities"][:_CAMPAIGN_ENTITIES_OBS]],
                 "entity_count": len(r["entities"]),
                 # Every technique up to the bound, and how many there are, so an answer
                 # never shows three of four with nothing saying one is missing.
                 "mitre": [text(t, 16) for t in r["mitre"][:_CAMPAIGN_TECHNIQUES_OBS]],
                 "mitre_count": len(r["mitre"]),
                 "severity": r["severity_rollup"], "first_seen": r["first_seen"], "last_seen": r["last_seen"],
                 **({"match": r["match"]} if r.get("match") else {})}
                for r in rows
            ],
        }
        columns = [
            column("campaign", "Campaign", untrusted=True), column("status", "Status", "status"),
            column("cases", "Cases", "number", align="right"), column("severity", "Severity", "severity"),
            column("first_seen", "First seen", "time"), column("last_seen", "Last seen", "time"),
            column("entities", "Shared entities", untrusted=True), column("mitre", "Techniques", "code"),
        ]
        table_rows = [
            [r["name"] or r["id"], r["status"], r["case_count"],
             r["severity_rollup"] if r["severity_rollup"] in ("critical", "high", "medium", "low", "info") else None,
             r["first_seen"], r["last_seen"],
             with_more([f"{e['entity_type']}:{e['value']}" for e in r["entities"]], _CAMPAIGN_CELL_ITEMS),
             with_more(list(r["mitre"]), _CAMPAIGN_CELL_ITEMS)]
            for r in rows
        ]
        open_count = sum(1 for r in rows if r["status"] == "open")
        artifacts = [
            Artifact(id="a1", kind="table", title="Campaigns", title_trusted=True,
                     data={"columns": columns, "rows": table_rows}, provenance="code",
                     untrusted_labels=True, total=total, truncated=total > len(rows)),
            Artifact(id="a2", kind="kpis", title="Campaign figures", title_trusted=True,
                     data={"items": [
                         kpi("campaigns", "Campaigns", total),
                         kpi("open", "Open (listed)", open_count),
                         kpi("cases", "Cases linked (listed)", sum(r["case_count"] for r in rows)),
                     ]}, provenance="code"),
        ]
        summary = f"{fmt_int(total)} campaign{'' if total == 1 else 's'}" + (
            f" with status {args.status}" if args.status else "")
        if args.case_id:
            summary += " holding the case" if member is not None else " (the case was not found)"
        elif args.entity and not args.campaign_id:
            summary += " involving the entity"
        summary += f"; {fmt_int(len(rows))} listed"
        untrusted = {key: value for key, value in (("campaign_id", args.campaign_id), ("case_id", args.case_id),
                                                   ("entity", args.entity))
                     if value}
        return ToolOutcome(ok=True, summary=summary, observation=observation, artifacts=artifacts,
                           rows=len(rows), basis="exact", untrusted_params=untrusted)


#: The most member cases a campaign listing reads display numbers for (one bounded read
#: each; the rest keep their id alone).
_CAMPAIGN_NUMBER_READS = 25
#: How many of a campaign's shared entities and ATT&CK techniques its observation
#: lists (``entity_count`` and ``mitre_count`` say how many there are), and how many
#: a table cell names before "and K more" (Round 13 close: a fourth technique was
#: dropped without a word).
_CAMPAIGN_ENTITIES_OBS = 5
_CAMPAIGN_TECHNIQUES_OBS = 12
_CAMPAIGN_CELL_ITEMS = 4


#: The most cases about an entity ``list_campaigns(entity=…)`` checks against the
#: campaigns' members (one store query; the observation says when there are more).
_ENTITY_CASE_READS = 500


async def _cases_about(ctx: ChatToolContext, value: str) -> tuple[set[str], int, int]:
    """``(ids of the cases about the entity, how many there are, how many were read)``:
    the cases whose entity has exactly this value, like ``search_cases(entity=…)``."""
    if ctx.cases is None:
        return set(), 0, 0
    try:
        page, count, _exact = await ctx.cases.list_window(entity_value=value, limit=_ENTITY_CASE_READS)
    except Exception as exc:  # noqa: BLE001 -- the shared entities alone still decide
        logger.info("list_campaigns entity case read failed: %s", exc)
        return set(), 0, 0
    ids = {str(getattr(c, "case_id", "") or "") for c in page} - {""}
    return ids, int(count), len(page)


def _involvement(campaign: Any, value: str, about: set[str]) -> str | None:
    """How ``campaign`` involves the entity: "shared_entity" (one of its shared
    entities has the value, compared without case), "member_case" (one of its cases
    is about it), else ``None``."""
    wanted = value.strip().lower()
    for entity in getattr(campaign, "entities", None) or []:
        if str(getattr(entity, "value", "") or "").strip().lower() == wanted:
            return "shared_entity"
    if about & {str(c) for c in getattr(campaign, "case_ids", None) or []}:
        return "member_case"
    return None


def with_more(items: list[Any], limit: int) -> str:
    """``items`` joined with commas: all of them when there are at most ``limit``, else
    the first ``limit - 1`` and "and K more" (never a silent cut)."""
    shown = [str(i) for i in items if i not in (None, "")]
    if len(shown) <= limit:
        return ", ".join(shown)
    keep = max(1, limit - 1)
    return f"{', '.join(shown[:keep])} and {len(shown) - keep} more"


async def _case_numbers(ctx: ChatToolContext, case_ids: list[Any]) -> dict[str, str]:
    """``{case_id: display number}`` for up to :data:`_CAMPAIGN_NUMBER_READS` distinct
    cases (a case without a number, or a failed read, is left out)."""
    out: dict[str, str] = {}
    if ctx.cases is None:
        return out
    for cid in list(dict.fromkeys(str(c) for c in case_ids if c))[:_CAMPAIGN_NUMBER_READS]:
        try:
            case = await ctx.cases.get(cid)
        except Exception as exc:  # noqa: BLE001 -- the id alone still names it
            logger.info("campaign member read failed: %s", exc)
            continue
        number = opt_text(getattr(case, "case_number", ""), 64) if case is not None else None
        if number and number != cid:
            out[cid] = number
    return out


# --------------------------------------------------------------------------- #
# explain_decision
# --------------------------------------------------------------------------- #
class ExplainDecisionInput(ToolInput):
    verdict: Literal[_VERDICTS] | None = None  # type: ignore[valid-type]
    confidence: float | None = Field(default=None, ge=0, le=1)
    risk_score: float | None = Field(default=None, ge=0, le=100)
    case_id: str | None = Field(default=None, max_length=128)
    include: list[Literal["forwarding"]] = Field(default_factory=list, max_length=1)

    @field_validator("verdict", mode="before")
    @classmethod
    def _verdict(cls, value: Any) -> Any:
        return _norm_enum(value, _VERDICTS, upper=True)

    @field_validator("confidence", mode="before")
    @classmethod
    def _confidence(cls, value: Any) -> Any:
        value = none_if_blank(value)
        # "85%" or 85 means 0.85: models often speak in percent.
        if isinstance(value, str) and value.strip().endswith("%"):
            try:
                return float(value.strip()[:-1]) / 100
            except ValueError:
                return value
        if isinstance(value, (int, float)) and not isinstance(value, bool) and 1 < value <= 100:
            return float(value) / 100
        return value

    @field_validator("risk_score", "case_id", mode="before")
    @classmethod
    def _blank(cls, value: Any) -> Any:
        return none_if_blank(value)

    @field_validator("include", mode="before")
    @classmethod
    def _include(cls, value: Any) -> Any:
        if value in (None, "", []):
            return []
        if isinstance(value, str):
            value = [value]
        return [v for v in value if str(v).strip().lower() == "forwarding"][:1] if isinstance(value, list) else value


def _policy_rows(policy: Any) -> list[dict[str, Any]]:
    rows = []
    for key, label in (("false_positive", "FALSE_POSITIVE"), ("true_positive", "TRUE_POSITIVE")):
        entry = getattr(policy, key, None)
        rows.append({
            "verdict": label,
            "auto_close_enabled": bool(getattr(entry, "enabled", False)),
            "min_confidence": finite(getattr(entry, "min_confidence", None)),
            "max_risk_score": finite(getattr(entry, "max_risk_score", None)),
            "objection_window_minutes": finite(getattr(entry, "objection_window_minutes", None)),
        })
    rows.append({"verdict": "NEEDS_HUMAN", "auto_close_enabled": False, "min_confidence": None,
                 "max_risk_score": None, "objection_window_minutes": None,
                 "note": "never auto-closes (enforced in code)"})
    return rows


class ExplainDecisionTool(ChatTool):
    name: ClassVar[str] = "explain_decision"
    label: ClassVar[str] = "Explained the decision policy"
    running_label: ClassVar[str] = "Explaining the decision policy"
    scope: ClassVar[str] = "cases"
    requires: ClassVar[tuple[tuple[str, str], ...]] = (("cases", "read"),)
    optional_grants: ClassVar[tuple[tuple[str, str], ...]] = (("sources", "read"),)
    data_source: ClassVar[str] = "Auto-close policy (deterministic)"
    signature: ClassVar[str] = (
        "explain_decision(verdict?=TRUE_POSITIVE|FALSE_POSITIVE|NEEDS_HUMAN, confidence?=0..1, risk_score?=0..100, "
        "case_id?, include?=[forwarding]) -- what the deterministic close/escalate policy would do, the "
        "policy itself, a case's recorded decision, and optionally why its alert was or was not forwarded"
    )
    display_keys: ClassVar[tuple[str, ...]] = ("verdict", "confidence", "risk_score", "case_id", "include")

    def display_params(self, inp: dict[str, Any]) -> dict[str, Any]:
        params = dict(inp) if isinstance(inp, dict) else {}
        if isinstance(params.get("include"), list):
            params["include"] = ",".join(str(i) for i in params["include"][:2])
        return super().display_params(params)

    async def run(self, ctx: ChatToolContext, **inp: Any) -> ToolOutcome:
        from ...engine.case_manager import decide

        args, error = parse_input(ExplainDecisionInput, inp)
        if error is not None:
            return error
        prefs = ctx.prefs
        policy = prefs.auto_close
        case_id = args.case_id or (ctx.case_id if not args.verdict else None)
        case = None
        if case_id:
            if ctx.cases is None:
                return ToolOutcome.failure("The case store is not available")
            case = await find_case(ctx, case_id)
            if case is None and args.case_id:
                return ToolOutcome.failure("Case not found")
        verdict_name = args.verdict or (enum_value(case.verdict) if case is not None else None)
        confidence = args.confidence if args.confidence is not None else (
            finite(case.confidence) if case is not None else None)
        risk = args.risk_score if args.risk_score is not None else (
            finite(case.risk_score) if case is not None else None)
        observation: dict[str, Any] = {"policy": _policy_rows(policy)}
        what_if = None
        if verdict_name is not None:
            decision = decide(
                Verdict(verdict_name), float(confidence or 0.0), float(risk or 0.0), policy,
                escalation_confidence=prefs.escalation_confidence,
                critical_severity=prefs.critical_severity,
            )
            what_if = {
                "verdict": verdict_name,
                "confidence": round(float(confidence or 0.0), 4),
                "risk_score": round(float(risk or 0.0), 2),
                "status": decision.status.value,
                "decision_by": decision.decision_by.value,
                "auto_closed": decision.status == CaseStatus.CLOSED,
                "escalate": decision.escalate,
                # Engine-authored text (verdict enum + numbers + policy values).
                "rationale": decision.rationale,
            }
            observation["what_if"] = what_if
        if case is not None:
            observation["recorded"] = {
                "case_id": text(case.case_id, 128),
                "status": enum_value(case.status),
                "decision_by": enum_value(case.decision_by),
                "verdict": enum_value(case.verdict),
                "last_decision_reason": _last_decision_reason(case),
            }
        notes: list[str] = []
        if "forwarding" in args.include:
            if case is None:
                notes.append("forwarding needs a case_id")
            elif not ctx.has("sources", "read"):
                notes.append("forwarding needs the sources:read permission")
            elif ctx.cluster_for_case is None:
                notes.append("forwarding is not available here")
            else:
                observation["forwarding"] = await self._forwarding(ctx, case)
        if notes:
            observation["notes"] = notes

        rows = _policy_rows(policy)
        artifacts = [Artifact(
            id="a1", kind="table", title="Auto-close policy", title_trusted=True,
            data={"columns": [
                column("verdict", "Verdict class", "verdict"), column("enabled", "Auto-close"),
                column("min_confidence", "Min confidence", "number", unit="ratio", align="right"),
                column("max_risk_score", "Max risk", "number", unit="score", align="right"),
                column("window", "Objection window", "number", unit="minutes", align="right"),
            ], "rows": [
                [r["verdict"].lower(), "on" if r["auto_close_enabled"] else "off", r["min_confidence"],
                 r["max_risk_score"], r["objection_window_minutes"]]
                for r in rows
            ]},
            provenance="code",
        )]
        if what_if is not None:
            entry = getattr(policy, "false_positive" if verdict_name == "FALSE_POSITIVE" else "true_positive", None) \
                if verdict_name in ("FALSE_POSITIVE", "TRUE_POSITIVE") else None
            items = [
                kpi("confidence", "Confidence", what_if["confidence"] * 100, "percent"),
                kpi("risk", "Risk score", what_if["risk_score"], "score"),
            ]
            if entry is not None:
                items.append(kpi("min_confidence", "Policy min confidence", (finite(entry.min_confidence) or 0) * 100, "percent"))
                items.append(kpi("max_risk", "Policy max risk", finite(entry.max_risk_score), "score"))
            artifacts.append(Artifact(
                id="a2", kind="kpis", title="Decision inputs", title_trusted=True,
                data={"items": items}, provenance="code",
            ))
        if what_if is not None:
            outcome_text = "auto-closed" if what_if["auto_closed"] else "routed to a human"
            # The gauge's integer (round half up, T1), never Python's half-to-even.
            summary = (f"{verdict_name} at confidence {what_if['confidence']:.2f} and risk "
                       f"{fmt_int(what_if['risk_score'])} would be {outcome_text}")
            if what_if["escalate"]:
                summary += " (escalated)"
        else:
            summary = "Auto-close policy read"
        forwarding = observation.get("forwarding")
        query = None
        if isinstance(forwarding, dict):
            # The forwarding explanation re-reads the case's source events (a log
            # read): the summary and the audit row's query text both say so.
            query = _FORWARDING_READ
            summary += f"; forwarding gate: {text(forwarding.get('gate'), 40) or 'unknown'} (case events re-read)"
        return ToolOutcome(ok=True, summary=summary, observation=observation, artifacts=artifacts,
                           basis="exact", rows=None, query=query,
                           untrusted_params={"case_id": str(case_id)[:128]} if case_id else {})

    async def _forwarding(self, ctx: ChatToolContext, case: Any) -> dict[str, Any]:
        from ...engine.forwarding import explain_forwarding

        try:
            cluster = await ctx.cluster_for_case(case)
        except Exception as exc:  # noqa: BLE001 — honest "unknown", never an error
            logger.info("forwarding cluster rebuild failed: %s", exc)
            cluster = None
        if cluster is None:
            return {
                "gate": "unknown", "forwarded": False, "dropped": False,
                "sentence": "The originating events for this case are no longer retrievable, "
                            "so the forwarding decision cannot be reconstructed.",
            }
        explanation = explain_forwarding(cluster, ctx.prefs).to_dict()
        return {
            "gate": explanation.get("gate"),
            "forwarded": bool(explanation.get("forwarded")),
            "dropped": bool(explanation.get("dropped")),
            # Engine-authored sentence and notes (gate names, numbers, config terms).
            "sentence": text(explanation.get("sentence"), 400),
            "notes": [text(n, 200) for n in (explanation.get("notes") or [])[:5]],
        }


__all__ = [
    "CASE_SCAN_LIMIT",
    "ExplainDecisionTool",
    "GetCaseTool",
    "ListCampaignsTool",
    "SearchCasesTool",
    "ShiftReportTool",
    "find_case",
    "load_case_page",
]
