"""Team activity: per-person work counts from the audit log (Round 15 SPEC D3).

The page a SOC manager opens to see what each person did, per day, in the operator time
zone. Every count is an exact fold over the append-only audit rows of the window (#2),
built by the pure :mod:`app.engine.team_activity`; nothing here writes a case, calls a
model or feeds ``decide()`` (#3, #6), and no answer reaches a prompt (#7).

* ``GET /api/team/activity?window=``: the window's counts, per person and per day.
* ``GET /api/team/people``: the roster (username, display name, role, active, kind).
* ``GET /api/team/people/{username}/events?window=&cursor=&limit=``: one person's
  counted events, newest first, at most 200 a page, behind a signed cursor.

**Who may read it.** Every route needs ``team:view`` (a SOC manager tracks the team, an
auditor may read it; super admins hold every grant). While role-based access is off,
every signed-in account holds every grant, so the routes also need a stored role of
Super admin, SOC manager or Auditor (SPEC D3.3), else ``403
team_activity_role_required`` and an Access denied row. Off by the operator switch
(``Preferences.team_activity.enabled``, SPEC D3.4) the routes answer ``409
team_activity_off``. With sign-in off nothing can be attributed to a person, so the
answer is empty and says so (``auth_enabled: false``).

**What is never on this page** (SPEC D3.5): an IP address, a user agent, a session or a
settings row (the Audit log keeps those under ``audit:view``), a ranking or a score. An
event's ``detail`` is built from structured fields only, never from a row's summary.

**Bounds** (SPEC D3.6): a window of at most 92 days (``422 team_window_too_long``), at
most 250,000 rows scanned, every page read without its total (``search_page`` with
``count=False``); an Elasticsearch read without point-in-time that reaches its
10,000-row limit, or a third-party store's bounded scan that fills (or the 250,000-row
budget), marks the answer partial with "at least" counts, and its medians and agreement
rate are omitted (``ack_status`` ``partial``), never computed from the part read.
Answers are cached per viewer and window for 60 seconds.

**Demo Mode** (SPEC D3.6, §3.2): case work comes from the Demo audit only and sign-ins
from the real control audit, so a real case never appears under the Demo badge.

**View auditing** (SPEC D3.10): reading the page writes one ``team.viewed`` row per
viewer per ten minutes, and opening a person's events one row per viewer and person per
ten minutes, best-effort, to the control audit.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import hmac
import inspect
import json
import logging
import time
import weakref
from collections import OrderedDict
from dataclasses import replace
from datetime import datetime
from typing import Any, Awaitable, Callable, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field

from ..audit import views
from ..engine import team_activity as ta
from ..state import AppState
from .deps import _rbac_enabled, get_state, record_access_denied, require_permission

logger = logging.getLogger("tlsoc.api.team")

router = APIRouter(prefix="/api/team", tags=["team"])

_TEAM_VIEW = require_permission("team", "view")

#: The stored roles that may read the page while role-based access is off (SPEC D3.3).
TEAM_FLOOR_ROLES: frozenset[str] = frozenset({"super_admin", "soc_manager", "auditor"})
#: How long one viewer's answer for one window is reused, in seconds.
CACHE_SECONDS = 60.0
#: The most answers kept (least recently used dropped first).
CACHE_MAX_ENTRIES = 128
#: Rows read per store page (the largest page ``search_page`` returns).
PAGE_ROWS = 1000
#: The most events on one page of a person's events.
EVENTS_PAGE_MAX = 200
EVENTS_PAGE_DEFAULT = 50
#: The most reviewed cases whose sample rows are read for "Time to review".
REVIEW_CASES_LIMIT = 1000
#: The case ids read in one batch for the time to acknowledge.
CASE_BATCH = 500
#: The longest cursor accepted.
CURSOR_MAX_CHARS = 2048
_CURSOR_VERSION = 1


# --------------------------------------------------------------------------- #
# Response models (feature-local; SPEC §4.6 keeps them out of models.py)
# --------------------------------------------------------------------------- #
class TeamWindow(BaseModel):
    token: str
    label: str
    start: str | None = None
    end: str


class TeamReviews(BaseModel):
    completed: int = 0
    agreed: int = 0
    disagreed: int = 0
    unsure: int = 0
    answered: int = 0
    agreement_rate: float | None = Field(
        default=None, description="Agreed over answered, only from 30 answered reviews.",
    )
    time_spent_median_ms: float | None = Field(
        default=None, description="Median time spent on the review card, measured in the Console.",
    )
    time_to_review_median_seconds: float | None = Field(
        default=None, description="Median time from the case being picked for review to the review.",
    )


class TeamDay(BaseModel):
    date: str
    counts: dict[str, int]


class PersonActivity(BaseModel):
    key: str = Field(description="The normalised username; empty for Not attributed.")
    username: str
    display_name: str = ""
    role: str = ""
    active: bool = True
    kind: Literal["account", "environment", "demo", "deleted", "unattributed"]
    counts: dict[str, int]
    closed_by: dict[str, int]
    bulk: dict[str, int]
    daily: list[TeamDay]
    last_active: str | None = None
    median_ack_seconds: float | None = None
    ack_samples: int = 0
    reviews: TeamReviews


class TeamTotals(BaseModel):
    people_active: int = 0
    counts: dict[str, int]
    closed_by: dict[str, int]
    bulk: dict[str, int]
    daily: list[TeamDay]
    median_ack_seconds: float | None = None
    ack_samples: int = 0
    ack_status: Literal["measured", "too_many_cases", "unavailable", "partial"] = Field(
        default="measured",
        description=(
            "Whether the median time to acknowledge was measured: too many cases, the cases "
            "could not be read, or the audit read stopped before the end of the window "
            "(partial). It is omitted unless measured."
        ),
    )
    reviews: TeamReviews


class TeamActivity(BaseModel):
    """One window of Team activity (SPEC D3.10)."""

    window: TeamWindow
    timezone: str
    days: list[str]
    people: list[PersonActivity]
    team: TeamTotals
    exact: bool = True
    partial_reason: Literal["row_limit", "store_limit"] | None = None
    scanned_rows: int = 0
    auth_enabled: bool = True
    rbac_enabled: bool = False
    demo: bool = False
    generated_at: str


class TeamPerson(BaseModel):
    username: str
    display_name: str = ""
    role: str = ""
    active: bool = True
    kind: Literal["account", "environment", "demo"]


class TeamPeople(BaseModel):
    people: list[TeamPerson]
    auth_enabled: bool = True
    demo: bool = False


class TeamEvent(BaseModel):
    ts: str
    kind: str
    label: str
    case_id: str | None = None
    case_number: str | None = None
    detail: str = ""


class TeamEvents(BaseModel):
    username: str
    window: TeamWindow
    events: list[TeamEvent]
    total: int
    next_cursor: str | None = None
    exact: bool = True
    partial_reason: Literal["row_limit", "store_limit"] | None = None


# --------------------------------------------------------------------------- #
# Errors and gates
# --------------------------------------------------------------------------- #
def _http(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, "message": message})


def _auth_enabled(state: AppState) -> bool:
    auth = getattr(state, "auth", None)
    return bool(auth is not None and getattr(auth, "is_enabled", False))


async def _gate(request: Request, state: AppState, user: Any) -> None:
    """The role floor while role-based access is off (D3.3), then the switch (D3.4)."""
    if _auth_enabled(state) and user is not None and not _rbac_enabled(state):
        raw = getattr(user, "role", "")
        role = str(getattr(raw, "value", raw) or "")
        if role not in TEAM_FLOOR_ROLES:
            await record_access_denied(request, [("team", "view")])
            raise _http(
                403, "team_activity_role_required",
                "Role-based access is off. Only Super admins, SOC managers and Auditors can open "
                "Team activity until it is on.",
            )
    config = getattr(state.prefs, "team_activity", None)
    if config is not None and not bool(getattr(config, "enabled", True)):
        raise _http(
            409, "team_activity_off",
            "Team activity is turned off. An administrator can turn it on in Settings, Security & "
            "access, Single sign-on & policy, Team activity.",
        )


def _window(state: AppState, token: str | None) -> Any:
    try:
        return ta.resolve_team_window(token, tz=ta.operator_zone(state.prefs))
    except ta.TeamWindowError as exc:
        raise _http(422, exc.code, exc.message) from None


def _viewer(user: Any) -> str:
    return str(getattr(user, "username", "") or "").strip().lower() or "anonymous"


def _demo_run(state: AppState) -> str:
    return str(getattr(state, "demo_run_id", None) or "")


def _request_context(request: Request) -> Any:
    try:
        from ..audit.context import audit_context

        return audit_context(request)
    except Exception as exc:  # noqa: BLE001 (a view row must never fail the read)
        logger.debug("audit context unavailable for a team view row: %s", exc)
        return None


async def _note_view(state: AppState, request: Request, user: Any, view: dict[str, Any], summary: str) -> None:
    if not _auth_enabled(state):
        return
    await views.TEAM_RECORDER.note(
        state.control_audit,
        actor=str(getattr(user, "username", "") or "") or "default",
        view=view,
        summary=summary,
        context=_request_context(request),
    )


# --------------------------------------------------------------------------- #
# The 60 second cache (per viewer and window), single flight
# --------------------------------------------------------------------------- #
class _AnswerCache:
    """Answers kept for :data:`CACHE_SECONDS`, least recently used dropped first. One
    computation per key at a time: a second read of the same key while the first is
    running waits for it. The computation runs as its own task, so a reader that goes
    away does not cancel it for the others."""

    def __init__(self, ttl: float = CACHE_SECONDS, max_entries: int = CACHE_MAX_ENTRIES,
                 clock: Callable[[], float] = time.monotonic) -> None:
        self._ttl = ttl
        self._max = max_entries
        self._clock = clock
        self._done: OrderedDict[tuple[Any, ...], tuple[float, Any]] = OrderedDict()
        self._running: dict[tuple[Any, ...], "asyncio.Future[Any]"] = {}

    def clear(self) -> None:
        self._done.clear()
        self._running.clear()

    def _store(self, key: tuple[Any, ...], task: "asyncio.Future[Any]") -> None:
        if self._running.get(key) is task:
            self._running.pop(key, None)
        if task.cancelled() or task.exception() is not None:
            return
        self._done[key] = (self._clock() + self._ttl, task.result())
        self._done.move_to_end(key)
        while len(self._done) > self._max:
            self._done.popitem(last=False)

    async def get(self, key: tuple[Any, ...], compute: Callable[[], Awaitable[Any]]) -> Any:
        hit = self._done.get(key)
        if hit is not None and hit[0] > self._clock():
            self._done.move_to_end(key)
            return hit[1]
        task = self._running.get(key)
        if task is None:
            task = asyncio.ensure_future(_gated(compute))
            self._running[key] = task
            task.add_done_callback(lambda t, k=key: self._store(k, t))
        return await asyncio.shield(task)


#: At most this many folds run at once in the process; others wait their turn.
FOLDS_AT_ONCE = 2
_FOLD_GATES: "weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, asyncio.Semaphore]" = weakref.WeakKeyDictionary()


async def _gated(compute: Callable[[], Awaitable[Any]]) -> Any:
    loop = asyncio.get_running_loop()
    gate = _FOLD_GATES.get(loop)
    if gate is None:
        gate = asyncio.Semaphore(FOLDS_AT_ONCE)
        _FOLD_GATES[loop] = gate
    async with gate:
        return await compute()


#: One cache per application state (a test's fresh state never sees another's answers).
_CACHES: "weakref.WeakKeyDictionary[Any, _AnswerCache]" = weakref.WeakKeyDictionary()


def answer_cache(state: AppState) -> _AnswerCache:
    """The Team activity answer cache of ``state``."""
    cache = _CACHES.get(state)
    if cache is None:
        cache = _AnswerCache()
        _CACHES[state] = cache
    return cache


# --------------------------------------------------------------------------- #
# Reading the audit (one snapshot per store, no totals)
# --------------------------------------------------------------------------- #
def _accepts_count(repo: Any) -> bool:
    """Whether the store's ``search_page`` takes ``count`` (a third-party repository
    written before Round 15 may not)."""
    try:
        return "count" in inspect.signature(repo.search_page).parameters
    except (TypeError, ValueError, AttributeError):
        return False


async def _stream(repo: Any, predicate: Any, sink: Callable[[dict[str, Any]], Any], budget: int) -> tuple[int, str | None]:
    """Feed every matching row of ``repo`` to ``sink``, oldest first, inside the
    store's snapshot; ``(rows read, partial reason or None)``. Raises on a store
    failure (the route answers 503)."""
    if repo is None:
        return 0, None
    counting = {"count": False} if _accepts_count(repo) else {}
    cursor: Any = None
    hold: Any = None
    read = 0
    reason: str | None = None
    try:
        while True:
            page = await repo.search_page(predicate, order="asc", limit=PAGE_ROWS, cursor=cursor, **counting)
            if hold is None and page.start is not None:
                hold = page.start
            hits = list(page.hits)
            for hit in hits:
                if read >= budget:
                    reason = "row_limit"
                    break
                sink(hit.doc if isinstance(hit.doc, dict) else {})
                read += 1
            if reason is None and read >= budget and not page.exhausted:
                # The budget is spent with rows still to read.
                reason = "row_limit"
            if hits:
                cursor = hits[-1].position
                hold = cursor
            if reason is not None:
                break
            if getattr(page, "truncated", False):
                reason = "store_limit"
                break
            if page.exhausted or not hits:
                break
    finally:
        if hold is not None:
            try:
                await repo.close_search_cursor(hold)
            except Exception as exc:  # noqa: BLE001 (a snapshot left open expires on its own)
                logger.debug("team activity: closing a read snapshot failed: %s", exc)
    return read, reason


def _sources(state: AppState) -> list[tuple[Any, bool, bool]]:
    """``(store, read case work, read sign-ins)`` per store: the control store alone with
    Demo Mode off; with it on, case work from the Demo audit and sign-ins from the
    control audit (SPEC D3.6)."""
    control = state.control_audit
    demo = getattr(state, "demo_audit", None)
    if demo is None:
        return [(control, True, True)]
    return [(demo, True, False), (control, False, True)]


async def _cases_by_id(store: Any, case_ids: list[str]) -> dict[str, Any]:
    found: dict[str, Any] = {}
    batch = getattr(store, "get_many", None)
    for start in range(0, len(case_ids), CASE_BATCH):
        chunk = case_ids[start:start + CASE_BATCH]
        if callable(batch):
            found.update(dict(await batch(chunk)))
        missing = [cid for cid in chunk if cid not in found]
        if missing:
            gate = asyncio.Semaphore(8)

            async def one(case_id: str) -> tuple[str, Any]:
                async with gate:
                    return case_id, await store.get(case_id)

            for case_id, case in await asyncio.gather(*(one(cid) for cid in missing)):
                if case is not None:
                    found[case_id] = case
    return found


def _environment_accounts(state: AppState, persisted: set[str]) -> list[tuple[str, str]]:
    """The sign-in accounts the environment supplies with no persisted record, with
    their role: the keys of ``Secrets.auth_user_map()``, computed without hashing a
    password."""
    secrets = getattr(state, "secrets", None)
    if secrets is None:
        return []
    names = list(getattr(secrets, "auth_users", {}) or {})
    admin = str(getattr(secrets, "auth_admin_username", "") or "")
    if getattr(secrets, "auth_admin_password", "") and admin and admin not in names:
        names.append(admin)
    auth = getattr(state, "auth", None)
    out: list[tuple[str, str]] = []
    for name in names:
        if not name or name.strip().lower() in persisted:
            continue
        role = ""
        principal = getattr(auth, "principal", None)
        if callable(principal):
            try:
                who = principal(name)
            except Exception:  # noqa: BLE001
                who = None
            raw = getattr(who, "role", "") if who is not None else ""
            role = str(getattr(raw, "value", raw) or "")
        if not role:
            role = "super_admin" if name == admin else ""
        out.append((name, role))
    return out


async def _roster(state: AppState) -> list[ta.RosterEntry]:
    accounts: list[Any] = []
    users = getattr(state, "users", None)
    if users is not None:
        try:
            accounts = list(await users.list())
        except Exception as exc:  # noqa: BLE001 (the page still lists who the rows name)
            logger.warning("team activity: the user store could not be read: %s", exc)
    persisted = {str(getattr(u, "username", "") or "").strip().lower() for u in accounts}
    demo: tuple[str, ...] = ()
    if getattr(state, "demo_active", False):
        from ..engine.demo_generator import DEMO_SOC_ANALYSTS

        demo = DEMO_SOC_ANALYSTS
    return ta.build_roster(accounts, _environment_accounts(state, persisted), demo)


def _flags(state: AppState) -> dict[str, Any]:
    return {
        "auth_enabled": _auth_enabled(state),
        "rbac_enabled": _rbac_enabled(state),
        "demo": bool(getattr(state, "demo_active", False)),
    }


async def _fold(state: AppState, window: Any) -> tuple[ta.TeamActivityFold, str | None]:
    """The window's fold over every store (raises on a store failure)."""
    fold = ta.TeamActivityFold(window)
    budget = ta.MAX_SCANNED_ROWS
    reason: str | None = None
    for repo, work, sign_ins in _sources(state):
        predicate = ta.counted_predicate(window, work=work, sign_ins=sign_ins)
        left = budget - fold.scanned
        if left <= 0:
            reason = reason or "row_limit"
            break
        _read, partial = await _stream(repo, predicate, fold.add_row, left)
        if partial is not None and reason is None:
            reason = partial
    return fold, reason


class _Computed:
    """One cached answer: the response and, kept off it, every spelling of each
    person's actor the window's rows recorded (the events read matches all of them)."""

    __slots__ = ("result", "spellings", "end")

    def __init__(self, result: dict[str, Any], spellings: dict[str, list[str]], end: datetime) -> None:
        self.result = result
        self.spellings = spellings
        # The end of the window the answer counted: a person's events read while the
        # answer is cached stop there, so the sheet lists exactly what the row counts.
        self.end = end


async def _compute_activity(state: AppState, window: Any) -> _Computed:
    fold, reason = await _fold(state, window)
    work_store = next((repo for repo, work, _ in _sources(state) if work), None)
    # A read that stopped before the end of the window holds only its oldest part: the
    # counts are lower bounds, but a median of that part is not one, so the medians are
    # not measured (the fold omits them; nothing more is read for them here).
    # "Time to review": the sample row of each reviewed case (bounded). A sample read that
    # stops early would leave later reviews without their sample, so it is not used.
    reviewed = fold.reviewed_case_ids()
    if reason is None and reviewed and len(reviewed) <= REVIEW_CASES_LIMIT and work_store is not None:
        rows: list[dict[str, Any]] = []
        try:
            _read, sampled_partial = await _stream(
                work_store, ta.review_request_predicate(window, reviewed), rows.append, 10 * REVIEW_CASES_LIMIT,
            )
            if sampled_partial is None:
                fold.add_review_requests(rows)
        except Exception as exc:  # noqa: BLE001 (the reviews keep their counts)
            logger.warning("team activity: review sample rows could not be read: %s", exc)
    # The median time to acknowledge: exact up to ACK_CASES_LIMIT cases, else omitted.
    acknowledged = fold.acknowledged_case_ids()
    ack_status = "measured"
    if reason is not None:
        ack_status = "partial"
    elif len(acknowledged) > ta.ACK_CASES_LIMIT:
        ack_status = "too_many_cases"
    elif acknowledged:
        try:
            fold.add_acknowledged_cases(await _cases_by_id(state.cases, acknowledged))
        except Exception as exc:  # noqa: BLE001 (the counts stand; the median is unavailable)
            logger.warning("team activity: acknowledged cases could not be read: %s", exc)
            ack_status = "unavailable"
    result = fold.result(await _roster(state), partial_reason=reason, ack_status=ack_status)
    result.update(_flags(state))
    result["generated_at"] = datetime.now().astimezone().isoformat()
    return _Computed(result, {key: fold.spellings(key) for key in fold.people_keys() if key}, window.end)


async def _activity(state: AppState, user: Any, window: Any) -> _Computed:
    return await answer_cache(state).get(
        _cache_key(state, user, "activity", window), lambda: _compute_activity(state, window),
    )


def _empty_activity(state: AppState, window: Any) -> dict[str, Any]:
    """The answer with sign-in off: nothing can be attributed to a person."""
    fold = ta.TeamActivityFold(window)
    result = fold.result([], partial_reason=None)
    result.update(_flags(state))
    result["generated_at"] = datetime.now().astimezone().isoformat()
    return result


def _cache_key(state: AppState, user: Any, kind: str, window: Any, *extra: Any) -> tuple[Any, ...]:
    """One viewer's answer for one window. The window is named by its token, zone and
    start: a window that runs to now (``today``, ``now-7d``) ends at a new instant on
    every read, and its answer is reused for :data:`CACHE_SECONDS` whatever that end is.
    A person's events page past the first carries its fixed end in ``extra``."""
    return (kind, _viewer(user), _demo_run(state), window.tz, window.token,
            window.start.isoformat() if window.start else "", *extra)


# --------------------------------------------------------------------------- #
# The events cursor (signed; offset into one fixed window)
# --------------------------------------------------------------------------- #
def _cursor_key(state: AppState) -> bytes:
    return hashlib.sha256(b"agentic-soc:team-events-cursor:v1\x00" + state.export_cursor_signing_key).digest()


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _encode_cursor(state: AppState, payload: dict[str, Any]) -> str:
    body = _b64(json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8"))
    signature = _b64(hmac.new(_cursor_key(state), body.encode("ascii"), hashlib.sha256).digest())
    return f"{body}.{signature}"


def _decode_cursor(state: AppState, cursor: str, *, viewer: str, person: str, token: str) -> dict[str, Any]:
    stale = _http(409, "team_cursor_expired", "The list was refreshed. Open the events again.")
    if len(cursor) > CURSOR_MAX_CHARS or not cursor.isascii() or cursor.count(".") != 1:
        raise _http(400, "team_cursor_invalid", "That cursor is not one this server issued.")
    body, signature = cursor.split(".", 1)
    expected = _b64(hmac.new(_cursor_key(state), body.encode("ascii"), hashlib.sha256).digest())
    if not hmac.compare_digest(expected.encode("ascii"), signature.encode("ascii")):
        raise stale
    try:
        value = json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)).decode("utf-8"))
    except (binascii.Error, UnicodeDecodeError, json.JSONDecodeError, ValueError):
        raise _http(400, "team_cursor_invalid", "That cursor is not one this server issued.") from None
    if (
        not isinstance(value, dict)
        or value.get("v") != _CURSOR_VERSION
        or value.get("sub") != hashlib.sha256(viewer.encode("utf-8")).hexdigest()
        or value.get("u") != person
        or value.get("w") != token
        or value.get("d") != _demo_run(state)
        or not isinstance(value.get("o"), int) or value["o"] < 0
        or not isinstance(value.get("tf"), str) or not isinstance(value.get("tt"), str)
    ):
        raise stale
    return value


# --------------------------------------------------------------------------- #
# Routes
# --------------------------------------------------------------------------- #
@router.get("/activity", response_model=TeamActivity)
async def team_activity(
    request: Request,
    window: str | None = Query(default=None, max_length=ta.WINDOW_TOKEN_MAX_CHARS,
                               description="A time window: today, yesterday, now-7d, or a date range."),
    state: AppState = Depends(get_state),
    user: Any = Depends(_TEAM_VIEW),
) -> dict[str, Any]:
    await _gate(request, state, user)
    resolved = _window(state, window)
    if not _auth_enabled(state):
        return _empty_activity(state, resolved)
    try:
        result = (await _activity(state, user, resolved)).result
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001 (any store failure is "could not be read")
        logger.warning("team activity could not be read: %s", exc)
        raise _http(503, "team_activity_unavailable", "The audit log could not be read. Try again.") from exc
    await _note_view(state, request, user, {"view": "team"}, "Viewed Team activity.")
    return result


@router.get("/people", response_model=TeamPeople)
async def team_people(
    request: Request,
    state: AppState = Depends(get_state),
    user: Any = Depends(_TEAM_VIEW),
) -> dict[str, Any]:
    await _gate(request, state, user)
    people = [ta.roster_view(e) for e in await _roster(state)] if _auth_enabled(state) else []
    people.sort(key=lambda p: ((p["display_name"] or p["username"]).lower(), p["username"].lower()))
    await _note_view(state, request, user, {"view": "team"}, "Viewed Team activity.")
    return {"people": people, "auth_enabled": _auth_enabled(state),
            "demo": bool(getattr(state, "demo_active", False))}


async def _fixed_window_activity(state: AppState, user: Any, window: Any) -> _Computed:
    """The answer a later events page checks the person and the spellings against.
    ``window`` is the one its cursor fixed: the window's token resolved when the first
    page was read, with the end that page stopped at."""
    try:
        current = ta.resolve_team_window(window.token, tz=window.tz)
    except ta.TeamWindowError:
        current = None
    if current is not None and current.start == window.start and current.end >= window.end:
        return await _activity(state, user, current)
    return await answer_cache(state).get(
        _cache_key(state, user, "activity", window, "fixed", window.end.isoformat()),
        lambda: _compute_activity(state, window),
    )


async def _person_events(
    state: AppState, user: Any, window: Any, key: str, *, first_page: bool,
) -> tuple[list[dict[str, Any]], str | None, Any]:
    """Every counted event of one person in the window, newest first, the partial
    reason and the window read (cached 60 s). The read matches every spelling of the
    person's actor the window's rows recorded (``In("actor", spellings)``), so "Admin"
    and "admin" are one person here as in the counts. A first page stops where the
    cached counts stopped, so the sheet lists exactly what the person's row counts; the
    cursor carries that end to the later pages.

    A later page reads the window the cursor fixed, which may end before now. The
    roster and the spellings then come from the page's own answer for the window as it
    stands (the same start, a later or equal end, so every spelling the fixed window
    holds is in it), and never from a fold of the fixed window stored under that answer's
    key: that would serve counts ending at the old instant to the next page read. Only
    when the window has moved on (``now-7d`` across midnight) is the fixed window folded,
    under a key of its own."""
    if first_page:
        computed = await _activity(state, user, window)
    else:
        computed = await _fixed_window_activity(state, user, window)
    listed = {p.get("key") for p in computed.result.get("people", [])}
    if key not in listed:
        raise _http(404, "team_person_not_found", "Nobody by that name is on this page.")
    if first_page and computed.end < window.end:
        window = replace(window, end=computed.end)
    spellings = computed.spellings.get(key)
    if not spellings:
        return [], None, window

    async def compute() -> tuple[list[dict[str, Any]], str | None]:
        from ..audit.query import In, all_of

        rows: list[dict[str, Any]] = []
        reason: str | None = None
        for repo, work, sign_ins in _sources(state):
            predicate = all_of(
                ta.counted_predicate(window, work=work, sign_ins=sign_ins), In("actor", tuple(spellings)),
            )
            _read, partial = await _stream(repo, predicate, rows.append, ta.MAX_SCANNED_ROWS - len(rows))
            if partial is not None and reason is None:
                reason = partial
        return ta.person_events(rows, window, key), reason

    events, reason = await answer_cache(state).get(
        _cache_key(state, user, "events", window, key, window.end.isoformat()), compute,
    )
    return events, reason, window


@router.get("/people/{username}/events", response_model=TeamEvents)
async def team_person_events(
    request: Request,
    username: str,
    window: str | None = Query(default=None, max_length=ta.WINDOW_TOKEN_MAX_CHARS),
    cursor: str | None = Query(default=None, max_length=CURSOR_MAX_CHARS),
    limit: int = Query(default=EVENTS_PAGE_DEFAULT, ge=1, le=EVENTS_PAGE_MAX),
    state: AppState = Depends(get_state),
    user: Any = Depends(_TEAM_VIEW),
) -> dict[str, Any]:
    await _gate(request, state, user)
    key = ta.person_key(username)
    if not key or len(username) > 160:
        # Not attributed has no events link (SPEC D3.9).
        raise _http(404, "team_person_not_found", "Nobody by that name is on this page.")
    resolved = _window(state, window)
    viewer = _viewer(user)
    offset = 0
    first_page = not cursor
    if cursor:
        value = _decode_cursor(state, cursor, viewer=viewer, person=key, token=resolved.token)
        # "Load more" reads the window the first page resolved, so a window such as
        # ``today`` does not move under it.
        try:
            start, end = datetime.fromisoformat(value["tf"]), datetime.fromisoformat(value["tt"])
        except ValueError:
            raise _http(409, "team_cursor_expired", "The list was refreshed. Open the events again.") from None
        if start.tzinfo is None or end.tzinfo is None or not start < end:
            raise _http(409, "team_cursor_expired", "The list was refreshed. Open the events again.")
        resolved = replace(resolved, start=start, end=end)
        offset = int(value["o"])
    if not _auth_enabled(state):
        raise _http(404, "team_person_not_found", "Nobody by that name is on this page.")
    try:
        events, reason, resolved = await _person_events(state, user, resolved, key, first_page=first_page)
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        logger.warning("team activity events could not be read: %s", exc)
        raise _http(503, "team_activity_unavailable", "The audit log could not be read. Try again.") from exc
    page = events[offset: offset + limit]
    next_cursor = None
    if offset + limit < len(events):
        next_cursor = _encode_cursor(state, {
            "v": _CURSOR_VERSION,
            "sub": hashlib.sha256(viewer.encode("utf-8")).hexdigest(),
            "u": key,
            "w": resolved.token,
            "d": _demo_run(state),
            "tf": resolved.start.isoformat() if resolved.start else "",
            "tt": resolved.end.isoformat(),
            "o": offset + limit,
        })
    await _note_view(
        state, request, user, {"view": "person", "person": key},
        # The name as the rows recorded it, one printable line (``views.plain``).
        f"Viewed the Team activity of {views.plain(username.strip(), limit=160)}.",
    )
    return {
        "username": username.strip(),
        "window": {
            "token": resolved.token,
            "label": resolved.label,
            "start": resolved.start.isoformat() if resolved.start else None,
            "end": resolved.end.isoformat(),
        },
        "events": page,
        "total": len(events),
        "next_cursor": next_cursor,
        "exact": reason is None,
        "partial_reason": reason,
    }
