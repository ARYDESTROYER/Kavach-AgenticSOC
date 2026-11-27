"""Store-level ``created_at`` windowing for the case listing (P4).

WHAT WAS BROKEN. ``GET /api/cases`` fetched ONE bounded page (``limit=min(limit, 200)``),
filtered it by ``from``/``to`` in Python, then overwrote ``total = len(cases)``. Three
consequences, all asserted against here:

* a windowed ``total`` could never exceed the page cap, so a 7d/30d comparison fetch
  could report ZERO while the true count was in the hundreds — every delta at those
  ranges was then computed against an empty comparison set;
* the window only ever saw the newest rows in the corpus, so any page past the first was
  drawn from the wrong slice;
* the never-drop-on-error contract (#4) was DEAD CODE. The filter wrapped its parse in
  ``except Exception`` and commented "never-drop", but ``utils.relative_to_millis`` never
  raises — it ends in ``return to_millis(dt) if dt else to_millis(now)``. An unparseable
  ``created_at`` therefore resolved to NOW, which looks like a successful parse, and was
  silently DROPPED from every historical window. Only the empty-string branch preserved.

The fix is :meth:`CaseRepository.list_window`, a NON-abstract method with a working
bounded-scan default (so third-party repositories keep working without a ``TypeError``)
that the bundled Elasticsearch and SQL repositories override with a native push-down.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.state import AppState
from app.config import Secrets
from app.constants import CaseStatus, EntityType, SourceSurface
from app.es.fake import InMemoryESClient
from app.llm.providers import MockProvider
from app.models import Case, Entity
from app.stores.base import CaseRepository, case_in_created_window
from app.stores.cases import CaseStore
from app.stores.sql import SqlCaseRepository, build_async_engine, create_all
from app.utils import (
    millis_to_iso_utc,
    parse_millis_strict,
    relative_to_iso_utc_strict,
    relative_to_millis,
    relative_to_millis_strict,
)

# The corpus every backend is seeded with. 250 cases INSIDE [now-30d, now-7d] — more than
# the 200-row page cap, which is the whole point — plus 60 cases NEWER than the window's
# upper bound. Because cases sort created_at-desc, those 60 sit AHEAD of the window in the
# unwindowed listing, so a page taken at offset 200 lands on completely different rows
# depending on whether the window was applied at the store or after the fetch.
IN_WINDOW = 250
TOO_NEW = 60


def _iso(dt: datetime) -> str:
    return dt.isoformat()


def _corpus(now: datetime) -> list[Case]:
    cases: list[Case] = []
    for i in range(TOO_NEW):
        cases.append(_case(f"new-{i:03d}", _iso(now - timedelta(minutes=i + 1))))
    for i in range(IN_WINDOW):
        cases.append(_case(f"win-{i:03d}", _iso(now - timedelta(days=8, hours=i))))
    return cases


def _case(case_id: str, created_at: str) -> Case:
    return Case(
        case_id=case_id,
        cluster_signature=f"sig-{case_id}",
        source_surface=SourceSurface.AUTOMATED_SCAN,
        status=CaseStatus.OPEN,
        entity=Entity(type=EntityType.IP, value="203.0.113.10"),
        created_at=created_at,
        updated_at=created_at,
    )


async def _seed(repo: CaseRepository, cases: list[Case]) -> None:
    for case in cases:
        await repo.save(case)


@pytest.fixture
def now() -> datetime:
    return datetime.now(timezone.utc)


@pytest_asyncio.fixture
async def es_repo(now: datetime) -> CaseStore:
    repo = CaseStore(InMemoryESClient())
    await _seed(repo, _corpus(now))
    return repo


@pytest_asyncio.fixture
async def sql_repo(now: datetime):
    engine = build_async_engine("sqlite+aiosqlite:///:memory:")
    await create_all(engine)
    repo = SqlCaseRepository(engine)
    await _seed(repo, _corpus(now))
    yield repo
    await engine.dispose()


@pytest.fixture(params=["es", "sql"])
def repo(request, es_repo, sql_repo) -> CaseRepository:
    """The SAME assertions run against both bundled backends."""
    return es_repo if request.param == "es" else sql_repo


# --------------------------------------------------------------------------- #
# Exactness: the windowed total is the TRUE count, not the page length.
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_windowed_total_is_exact_beyond_the_page_cap(repo, now) -> None:
    cases, total, exact = await repo.list_window(
        created_from=_iso(now - timedelta(days=30)),
        created_to=_iso(now - timedelta(days=7)),
        limit=50,
    )
    # 250 > the 200-row page cap and > the 50-row page actually fetched. Before the
    # push-down this reported 50 (``total = len(cases)`` over one filtered page).
    assert total == IN_WINDOW
    assert exact is True
    assert len(cases) == 50


@pytest.mark.asyncio
async def test_relative_window_expression_pushes_down_too(repo) -> None:
    _cases, total, exact = await repo.list_window(
        created_from="now-30d", created_to="now-7d", limit=10,
    )
    assert (total, exact) == (IN_WINDOW, True)


@pytest.mark.asyncio
async def test_windowed_total_honours_the_other_filters(repo, now) -> None:
    _cases, total, exact = await repo.list_window(
        created_from="now-30d", created_to="now-7d",
        source_surface=SourceSurface.INVESTIGATE.value, limit=10,
    )
    assert (total, exact) == (0, True)


# --------------------------------------------------------------------------- #
# Rows: the window is applied at the STORE, so deep pages come from the middle
# of the window rather than from the newest rows in the corpus.
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_deep_page_returns_the_middle_of_the_window(repo, now) -> None:
    cases, total, _exact = await repo.list_window(
        created_from=_iso(now - timedelta(days=30)),
        created_to=_iso(now - timedelta(days=7)),
        limit=50, offset=200,
    )
    ids = [c.case_id for c in cases]
    # created_at-desc within the window: rows 200..249 are its OLDEST 50.
    assert ids == [f"win-{i:03d}" for i in range(200, 250)]
    assert total == IN_WINDOW
    # The pre-fix path filtered AFTER paging the unwindowed corpus, where the 60
    # newer-than-the-window cases occupy the first 60 slots — offset 200 landed on
    # win-140..win-189. Prove we are not reading that slice.
    assert "win-140" not in ids


@pytest.mark.asyncio
async def test_first_page_is_the_newest_row_inside_the_window(repo, now) -> None:
    cases, _total, _exact = await repo.list_window(
        created_from="now-30d", created_to="now-7d", limit=1,
    )
    # NOT "new-000": that case is newer than the window's upper bound.
    assert [c.case_id for c in cases] == ["win-000"]


@pytest.mark.asyncio
async def test_open_ended_upper_bound_keeps_the_newer_rows(repo) -> None:
    _cases, total, exact = await repo.list_window(created_from="now-30d", limit=10)
    assert (total, exact) == (IN_WINDOW + TOO_NEW, True)


# --------------------------------------------------------------------------- #
# Never-drop (#4): an unreadable created_at is KEPT, on every backend.
#
# Parameterised over a GRID, not one literal. The single value this suite first used
# ("not-a-timestamp") is the one member of the class with no digits AND no ISO shape,
# so it was the one value on which all three implementations happened to agree — it
# proved nothing. Each literal below breaks a DIFFERENT mechanism:
#   * ''                          — the empty-string branch (the only one ever covered);
#   * 'not-a-timestamp'           — digit-free, ISO-shapeless;
#   * 'garbage-2026' / 'unknown-2024' / '08/31/2026 12:00:00'
#                                 — digit-BEARING. ``es/fake._to_comparable`` used to
#                                   mine the first digit run out of these, producing a
#                                   definite number that the range clause matched, so
#                                   the ``must_not`` complement DROPPED the row;
#   * '2026-13-45T99:99:99+00:00' / '9999-99-99T00:00:00+00:00' / '0000-00-00Tzzzzzz'
#                                 — ISO-SHAPED but invalid. These sailed through the
#                                   SQL ``____-__-__T%`` escape hatch into the
#                                   lexicographic comparison and sorted out of the
#                                   window.
# The assertion is cross-backend AGREEMENT, since disagreement is the property that was
# actually broken: two bundled stores returned different totals for one corpus and both
# claimed exact=True.
#
# SCOPE, stated so the grid's edges are deliberate rather than accidental: never-drop is
# a contract about values that CANNOT be placed in time, which is why every literal here
# is one ``parse_millis_strict`` rejects (pinned below). A bare numeral such as
# "1772323200" is NOT in that class — it parses — it is merely AMBIGUOUS about its unit,
# and different date engines legitimately read it differently (this project reads it as
# epoch seconds; Elasticsearch's default ``date`` format reads it as epoch millis). No
# in-tree writer emits one, and resolving that ambiguity is a separate question from
# never-drop, so the grid deliberately stops short of it.
# --------------------------------------------------------------------------- #
UNREADABLE_CREATED_AT = [
    "",
    "not-a-timestamp",
    "garbage-2026",
    "unknown-2024",
    "08/31/2026 12:00:00",
    "2026-13-45T99:99:99+00:00",
    "9999-99-99T00:00:00+00:00",
    "0000-00-00Tzzzzzz",
]


@pytest.mark.parametrize("created_at", UNREADABLE_CREATED_AT)
def test_the_grid_really_is_unreadable(created_at: str) -> None:
    """Guards the guard: every literal above must be one the project's OWN parser
    cannot place in time, or the parity test below is asserting the wrong thing."""
    assert parse_millis_strict(created_at) is None
    assert case_in_created_window(_case("x", created_at), 1_000, 2_000) is True


@pytest.mark.parametrize("created_at", UNREADABLE_CREATED_AT)
def test_the_es_fake_reports_an_unreadable_value_as_incomparable(created_at: str) -> None:
    """The other end of the contract ``CaseStore.list_window`` documents.

    Its ``must_not`` complement only keeps an unplaceable row while the client's range
    evaluation says "no match" for it. On a real cluster that is structural (``date``
    mapping, no ``ignore_malformed``). On the in-memory client it holds only because
    ``_to_comparable`` refuses to invent a number — it used to mine the first digit run
    out of the string, and every digit-bearing literal here was dropped."""
    from app.es.fake import _to_comparable

    assert _to_comparable(created_at) is None


@pytest.mark.asyncio
@pytest.mark.parametrize("created_at", UNREADABLE_CREATED_AT)
async def test_unreadable_created_at_is_kept_in_a_window(repo, created_at: str) -> None:
    """REGRESSION. This FAILED before the push-down, and for most of these literals it
    still failed AFTER it.

    ``_window_cases_by_created`` claimed never-drop-on-error but routed the parse
    through ``relative_to_millis``, which resolves anything it cannot read to NOW
    instead of raising — so the ``except`` never fired and a garbage timestamp was
    silently excluded from every historical window."""
    await repo.save(_case("garbage-timestamp", created_at))
    cases, total, _exact = await repo.list_window(
        created_from="now-30d", created_to="now-7d", limit=500,
    )
    assert total == IN_WINDOW + 1
    assert "garbage-timestamp" in {c.case_id for c in cases}


@pytest.mark.asyncio
@pytest.mark.parametrize("created_at", UNREADABLE_CREATED_AT)
async def test_every_backend_returns_the_same_total(
    es_repo, sql_repo, now, created_at: str
) -> None:
    """The bundled Elasticsearch and SQL push-downs and the third-party Python default
    must agree WITH EACH OTHER, and with :func:`case_in_created_window` — the single
    definition of the contract — on the SAME corpus. They did not: for one 5-row
    fixture the three returned 2, 4 and 5, and two of them claimed ``exact=True``
    while doing it."""
    probe = _case("garbage-timestamp", created_at)
    default_repo = _MinimalCaseRepository(_corpus(now) + [probe])
    totals: dict[str, int] = {}
    for name, backend in (("es", es_repo), ("sql", sql_repo), ("default", default_repo)):
        if backend is not default_repo:
            await backend.save(probe)
        _cases, total, _exact = await backend.list_window(
            created_from="now-30d", created_to="now-7d", limit=500,
        )
        totals[name] = total
    assert totals == {
        "es": IN_WINDOW + 1, "sql": IN_WINDOW + 1, "default": IN_WINDOW + 1,
    }


# --------------------------------------------------------------------------- #
# Spelling: the SQL push-down compares strings, so a readable timestamp written in a
# different-but-equivalent spelling must still be placed at the right INSTANT.
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "spell",
    [
        # Exactly the window's upper bound. 'Z' (0x5A) sorts AFTER '+' (0x2B), so a
        # naive lexicographic compare drops a row sitting on the inclusive bound.
        lambda now: (now - timedelta(days=8)).isoformat().replace("+00:00", "Z"),
        # A non-UTC offset compared as local wall-clock is up to 14 hours wrong, with
        # inclusion inverted in BOTH directions.
        lambda now: (now - timedelta(days=8)).astimezone(
            timezone(timedelta(hours=5, minutes=30))
        ).isoformat(),
        lambda now: (now - timedelta(days=8)).astimezone(
            timezone(timedelta(hours=-8))
        ).isoformat(),
    ],
)
async def test_equivalent_spellings_land_at_the_same_instant(repo, now, spell) -> None:
    await repo.save(_case("odd-spelling", spell(now)))
    cases, total, exact = await repo.list_window(
        created_from="now-30d", created_to="now-7d", limit=500,
    )
    assert exact is True
    assert "odd-spelling" in {c.case_id for c in cases}
    assert total == IN_WINDOW + 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "spell",
    [
        lambda now: (now - timedelta(days=1)).isoformat().replace("+00:00", "Z"),
        lambda now: (now - timedelta(days=1)).astimezone(
            timezone(timedelta(hours=5, minutes=30))
        ).isoformat(),
    ],
)
async def test_equivalent_spellings_outside_the_window_are_still_excluded(
    repo, now, spell
) -> None:
    """The mirror of the test above: never-drop must not become never-filter."""
    await repo.save(_case("odd-spelling", spell(now)))
    cases, total, _exact = await repo.list_window(
        created_from="now-30d", created_to="now-7d", limit=500,
    )
    assert "odd-spelling" not in {c.case_id for c in cases}
    assert total == IN_WINDOW


# --------------------------------------------------------------------------- #
# Exactness is a CLAIM about the requested window, not about the branch taken.
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_unreadable_bound_is_treated_as_absent_not_as_now(repo) -> None:
    """A bound we cannot read must not silently become ``now()`` and empty the window.

    …but the window that WAS applied is then wider than the one requested, so the
    total may not be stamped as proof of it. Both halves matter: dropping the bound
    keeps the answer useful, and ``exact=False`` keeps it honest."""
    _cases, total, exact = await repo.list_window(
        created_from="not-a-time", created_to="now-7d", limit=10,
    )
    assert total == IN_WINDOW          # ``to`` still applied: the 60 newer rows are out
    assert exact is False              # …but ``from`` was silently dropped


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "bounds",
    [
        {"created_from": "not-a-time"},
        {"created_from": "not-a-time", "created_to": "also-garbage"},
        # ``now/d`` is not exotic: the Console picker's own parseDateMath accepts a
        # ``/unit`` rounding suffix and parseRange lifts from/to out of the URL
        # verbatim, so a bookmarked range reaches the route. The strict parser rejects
        # it (it requires ``+``/``-`` after ``now``).
        {"created_from": "now/d"},
        {"created_from": "now/d", "created_to": "now"},
    ],
)
async def test_a_window_that_could_not_be_applied_is_never_stamped_exact(
    repo, bounds: dict
) -> None:
    """REGRESSION. Every bound here is unreadable, so no window clause is applied and
    ``total`` is the WHOLE CORPUS. It used to come back stamped ``exact=True`` — the
    field says ``total`` is the proven count for the REQUESTED window, so that was the
    largest possible wrong number asserted as proof."""
    _cases, total, exact = await repo.list_window(limit=10, **bounds)
    assert total == IN_WINDOW + TOO_NEW
    assert exact is False


# --------------------------------------------------------------------------- #
# No window requested → exactly ``list()``.
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_no_window_matches_plain_list(repo) -> None:
    listed, list_total = await repo.list(limit=25)
    windowed, window_total, exact = await repo.list_window(limit=25)
    assert [c.case_id for c in windowed] == [c.case_id for c in listed]
    assert window_total == list_total == IN_WINDOW + TOO_NEW
    assert exact is True


@pytest.mark.parametrize("created_at", UNREADABLE_CREATED_AT)
def test_the_sql_column_marks_an_unreadable_value_as_unplaceable(created_at: str) -> None:
    """The SQL end of the same contract, at the write seam.

    A LIKE pattern cannot tell ``2026-13-45T99:99:99+00:00`` from a real timestamp, so
    the shape-only escape hatch let ISO-shaped garbage fall through to the
    lexicographic comparison and vanish. Normalising the materialised COLUMN at write
    time is what makes the never-drop branch exact instead of a heuristic."""
    from app.stores.sql.repositories import _canonical_created_at

    assert _canonical_created_at(created_at) == ""


@pytest.mark.parametrize(
    ("stored", "expected"),
    [
        ("2026-01-02T03:04:05+00:00", "2026-01-02T03:04:05+00:00"),
        ("2026-01-02T03:04:05Z", "2026-01-02T03:04:05+00:00"),
        ("2026-01-02T08:34:05+05:30", "2026-01-02T03:04:05+00:00"),
        ("2026-01-02T03:04:05.123456+00:00", "2026-01-02T03:04:05.123456+00:00"),
    ],
)
def test_the_sql_column_holds_one_spelling(stored: str, expected: str) -> None:
    """Every readable instant reaches the column in the ONE spelling string order can
    compare — microseconds preserved, ``Z`` and non-UTC offsets converted rather than
    carried through (``'Z'`` sorts after ``'+'``, so a row exactly on the inclusive
    upper bound was dropped; an offset was compared as local wall-clock)."""
    from app.stores.sql.repositories import _canonical_created_at

    assert _canonical_created_at(stored) == expected


# --------------------------------------------------------------------------- #
# Third-party compatibility: a repository that does NOT override list_window.
# --------------------------------------------------------------------------- #
class _MinimalCaseRepository(CaseRepository):
    """The smallest possible out-of-tree repository: only the ABSTRACT methods.

    It must keep working through the non-abstract ``list_window`` default — which is
    exactly why the window is a NEW method rather than a new keyword on ``list``."""

    def __init__(self, cases: list[Case]) -> None:
        self._cases = list(cases)

    async def save(self, case: Case) -> None:
        self._cases = [c for c in self._cases if c.case_id != case.case_id] + [case]

    async def get(self, case_id: str) -> Case | None:
        return next((c for c in self._cases if c.case_id == case_id), None)

    async def find_open_by_signature(self, signature: str) -> Case | None:
        return next((c for c in self._cases if c.cluster_signature == signature), None)

    async def list(
        self, *, status=None, source_surface=None, entity_value=None,
        limit: int = 50, offset: int = 0,
        sort_field: str = "created_at", sort_order: str = "desc",
    ) -> tuple[list[Case], int]:
        rows = sorted(
            self._cases,
            key=lambda c: getattr(c, sort_field, "") or "",
            reverse=sort_order == "desc",
        )
        return rows[offset: offset + limit], len(rows)

    async def list_scans(self, limit: int = 50) -> tuple[list[Case], int]:
        return await self.list(limit=limit)

    async def count_new_scans(self, since_iso: str) -> int:
        return 0


@pytest.mark.asyncio
async def test_third_party_repository_works_through_the_default(now) -> None:
    repo = _MinimalCaseRepository(_corpus(now))
    cases, total, exact = await repo.list_window(
        created_from="now-30d", created_to="now-7d", limit=50, offset=200,
    )
    # The default is honest: it scanned a bounded page and cannot PROVE the total.
    assert exact is False
    # It is still CORRECT here (the corpus fits inside the scan bound) — and, unlike the
    # old route-level filter, it pages the WINDOW rather than the raw corpus.
    assert total == IN_WINDOW
    assert [c.case_id for c in cases] == [f"win-{i:03d}" for i in range(200, 250)]


@pytest.mark.asyncio
async def test_third_party_default_also_keeps_unreadable_timestamps(now) -> None:
    repo = _MinimalCaseRepository(
        _corpus(now) + [_case("garbage-timestamp", "not-a-timestamp"), _case("blank", "")]
    )
    cases, total, exact = await repo.list_window(
        created_from="now-30d", created_to="now-7d", limit=500,
    )
    assert exact is False
    assert total == IN_WINDOW + 2
    assert {"garbage-timestamp", "blank"} <= {c.case_id for c in cases}


@pytest.mark.asyncio
async def test_third_party_default_with_no_window_is_plain_list(now) -> None:
    repo = _MinimalCaseRepository(_corpus(now))
    cases, total, exact = await repo.list_window(limit=5)
    assert (len(cases), total, exact) == (5, IN_WINDOW + TOO_NEW, True)


# --------------------------------------------------------------------------- #
# The strict time seam the never-drop contract now rests on.
# --------------------------------------------------------------------------- #
def test_relative_to_millis_still_defaults_to_now() -> None:
    """The lenient contract is UNCHANGED — other callers depend on the now-default."""
    fixed = datetime(2026, 8, 31, 12, 0, tzinfo=timezone.utc)
    assert relative_to_millis("not-a-timestamp", now=fixed) == int(fixed.timestamp() * 1000)


def test_relative_to_millis_strict_reports_failure() -> None:
    fixed = datetime(2026, 8, 31, 12, 0, tzinfo=timezone.utc)
    assert relative_to_millis_strict("not-a-timestamp", now=fixed) is None
    assert relative_to_millis_strict("", now=fixed) is None
    assert relative_to_millis_strict(None) is None
    # …while every expression the lenient parser genuinely understands still resolves.
    assert relative_to_millis_strict("now", now=fixed) == int(fixed.timestamp() * 1000)
    assert relative_to_millis_strict("now-1h", now=fixed) == int(fixed.timestamp() * 1000) - 3_600_000
    assert relative_to_millis_strict("2026-01-02T03:04:05Z") == relative_to_millis(
        "2026-01-02T03:04:05Z"
    )


def test_parse_millis_strict_reports_failure() -> None:
    assert parse_millis_strict("") is None
    assert parse_millis_strict("not-a-timestamp") is None
    assert parse_millis_strict("2026-01-02T03:04:05Z") is not None


def test_bounds_normalise_to_the_stored_iso_spelling() -> None:
    """Lexicographic comparison is only sound because both sides share one spelling."""
    # "…Z" and "+00:00" are the same instant and must normalise identically.
    assert relative_to_iso_utc_strict("2026-01-02T03:04:05Z") == "2026-01-02T03:04:05+00:00"
    assert relative_to_iso_utc_strict("2026-01-02T03:04:05+00:00") == "2026-01-02T03:04:05+00:00"
    # A non-UTC offset is converted, not carried through.
    assert relative_to_iso_utc_strict("2026-01-02T04:04:05+01:00") == "2026-01-02T03:04:05+00:00"
    assert relative_to_iso_utc_strict("nonsense") is None
    assert millis_to_iso_utc(0) == "1970-01-01T00:00:00+00:00"


def test_case_in_created_window_never_drops_unreadable_values() -> None:
    lo, hi = 1_000, 2_000
    assert case_in_created_window(_case("blank", ""), lo, hi) is True
    assert case_in_created_window(_case("garbage", "not-a-timestamp"), lo, hi) is True
    assert case_in_created_window(_case("early", "1970-01-01T00:00:00+00:00"), lo, hi) is False
    assert case_in_created_window(_case("inside", "1970-01-01T00:00:01+00:00"), lo, hi) is True


# --------------------------------------------------------------------------- #
# The route: GET /api/cases now returns the STORE's total + window_total_exact.
# --------------------------------------------------------------------------- #
@pytest.fixture
def client(now):
    from app.api.routes import router as monolith_router

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        secrets = Secrets(
            _env_file=None, es_store_enabled=False, redis_url="",
            anthropic_api_key=None, openai_api_key=None,
        )
        mock = MockProvider()
        state = AppState.create(
            secrets=secrets, es=InMemoryESClient(),
            provider_overrides={"anthropic": mock, "openai": mock, "mock": mock},
        )
        await state.startup(start_poller=False)
        await state.update_prefs(state.prefs.model_copy(update={"setup_complete": True}))
        await _seed(state.cases, _corpus(now))
        app.state.tlsoc = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    api.include_router(monolith_router)
    with TestClient(api) as test_client:
        yield test_client


def test_route_reports_the_true_windowed_total(client) -> None:
    body = client.get(
        "/api/cases", params={"from": "now-30d", "to": "now-7d", "limit": 50},
    ).json()
    assert body["total"] == IN_WINDOW          # was capped at the page length
    assert body["window_total_exact"] is True
    assert len(body["cases"]) == 50


def test_route_deep_window_page_is_not_empty(client) -> None:
    body = client.get(
        "/api/cases",
        params={"from": "now-30d", "to": "now-7d", "limit": 50, "offset": 200},
    ).json()
    assert [c["case_id"] for c in body["cases"]] == [
        f"win-{i:03d}" for i in range(200, 250)
    ]
    assert body["total"] == IN_WINDOW


def test_route_no_window_response_is_unchanged(client) -> None:
    body = client.get("/api/cases", params={"limit": 5}).json()
    # Same keys, same values as before the change — plus the additive marker, which is
    # null precisely because no window was requested.
    assert body["total"] == IN_WINDOW + TOO_NEW
    assert [c["case_id"] for c in body["cases"]] == [f"new-{i:03d}" for i in range(5)]
    assert body["window_total_exact"] is None
    assert set(body) == {"cases", "total", "window_total_exact"}


def test_route_window_total_survives_a_status_filter(client) -> None:
    body = client.get(
        "/api/cases",
        params={"from": "now-30d", "to": "now-7d", "status": CaseStatus.OPEN.value},
    ).json()
    assert body["total"] == IN_WINDOW
    assert body["window_total_exact"] is True


@pytest.mark.parametrize(
    "params",
    [
        {"from": "not-a-time"},
        {"from": "not-a-time", "to": "also-garbage"},
        # A rounding suffix the Console's own picker emits and the strict parser does
        # not accept — reachable from a bookmarked or hand-edited URL.
        {"from": "now/d"},
        {"to": "now/d"},
    ],
)
def test_route_never_stamps_an_unappliable_window_as_proven(client, params) -> None:
    """REGRESSION. The route only enters the windowed branch when a window WAS asked
    for, so ``window_total_exact=true`` here asserted that the WHOLE-CORPUS total is
    the proven count for a window that was never applied."""
    body = client.get("/api/cases", params={**params, "limit": 5}).json()
    assert body["total"] == IN_WINDOW + TOO_NEW
    assert body["window_total_exact"] is False
