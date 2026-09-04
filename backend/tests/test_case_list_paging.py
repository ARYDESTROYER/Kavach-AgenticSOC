"""Server-side sort, bounded offset paging and the scalar status GROUP on the case list.

WHAT WAS BROKEN. ``GET /api/cases`` could window and page, but it could not be ORDERED
and it could not be asked for a lifecycle SET, so a drill-down that wanted "the newest
page of the open queue, by risk" had to read one page of the newest rows and answer every
whole-population question over it in the browser. Four things had to be true before that
could change, and none of them were:

* the sort field reaches the Elasticsearch store as a query-document KEY, and the SQL
  store silently falls back to ``created_at`` for anything it does not recognise, so the
  two bundled backends DISAGREE about an unknown field and one of them answers a
  different question without saying so. An allow-list therefore has to sit ABOVE both;
* neither store appended a tiebreaker, so the order of rows tied on the primary sort key
  was undefined — and ``from``/``size`` paging over an undefined order repeats some rows
  on the next page and skips others;
* ``offset`` had no lower bound (real Elasticsearch rejects a negative ``from``; the
  in-memory client slices from the END and returns plausible WRONG rows) and no upper
  bound (crossing ``index.max_result_window`` is a backend error, not a truncation);
* a multi-value status filter cannot be a list on the wire, because the console's query
  helper stringifies an array into one comma-joined term that matches nothing, silently,
  at every layer.

Everything below is offline: the fake Elasticsearch client and SQLite. Where an assertion
CANNOT be made offline — tie ordering is the case — it is made on the emitted query SHAPE
instead of on observed rows, and says so.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from typing import Any

import pytest
import pytest_asyncio
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.routes import (
    CASE_PAGE_LIMIT,
    CASE_RESULT_WINDOW,
    CASE_SORT_FIELDS,
    CASE_SORT_ORDERS,
)
from app.config import Secrets
from app.constants import (
    OPEN_CASE_STATUSES,
    TERMINAL_CASE_STATUSES,
    CaseStatus,
    EntityType,
    SourceSurface,
)
from app.es.fake import InMemoryESClient
from app.llm.providers import MockProvider
from app.models import Case, Entity
from app.state import AppState
from app.stores.base import (
    CASE_STATUS_GROUPS,
    CaseRepository,
    case_in_status_group,
    status_group_statuses,
)
from app.stores.cases import CASE_SORT_TIEBREAKER, CaseStore, case_sort_clause
from app.stores.sql import SqlCaseRepository, build_async_engine, create_all
from app.stores.sql.repositories import _case_order_by

# A corpus that ties HARD on both sort axes: every case in a decade shares one
# ``risk_score``, and pairs of cases share one ``created_at`` second. Ties are the normal
# case for this data — the risk engine emits a small set of round values and timestamps
# are second-resolution — which is exactly why the tiebreaker exists.
GROUP_SIZE = 10
GROUPS = 6
CORPUS = GROUP_SIZE * GROUPS


def _iso(dt: datetime) -> str:
    return dt.isoformat()


def _corpus(now: datetime) -> list[Case]:
    cases: list[Case] = []
    lifecycle = list(OPEN_CASE_STATUSES) + list(TERMINAL_CASE_STATUSES)
    for i in range(CORPUS):
        cases.append(
            Case(
                case_id=f"case-{i:03d}",
                cluster_signature=f"sig-{i:03d}",
                source_surface=SourceSurface.AUTOMATED_SCAN,
                # Rotate through the WHOLE lifecycle vocabulary rather than naming
                # statuses here, so the group assertions below are about the product's
                # own taxonomy and not about a list restated in a test.
                status=CaseStatus(lifecycle[i % len(lifecycle)]),
                entity=Entity(type=EntityType.HOST, value=f"host-{i:03d}"),
                # Two cases per second → a tie on the created_at axis.
                created_at=_iso(now - timedelta(seconds=(i // 2) * 60)),
                updated_at=_iso(now - timedelta(seconds=i)),
                risk_score=float((i // GROUP_SIZE) * 10),
            )
        )
    return cases


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


class RecordingCases:
    """A case repository that records the arguments it was called with.

    Used for the assertions that are about what the ROUTE decided, which is a different
    question from what a store does with it.
    """

    def __init__(self) -> None:
        self.list_calls: list[dict[str, Any]] = []
        self.window_calls: list[dict[str, Any]] = []
        self.exact: bool | None = True
        self.rows: list[Case] = []
        self.total = 0

    async def list(self, **kw: Any) -> tuple[list[Case], int]:
        self.list_calls.append(kw)
        return list(self.rows), self.total

    async def list_window(self, **kw: Any) -> tuple[list[Case], int, bool | None]:
        self.window_calls.append(kw)
        return list(self.rows), self.total, self.exact


@pytest.fixture
def app_state(now):
    """A live AppState whose case repository can be swapped for a recorder."""

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

    from app.api.routes import router as monolith_router

    api = FastAPI(lifespan=lifespan)
    api.include_router(monolith_router)
    with TestClient(api) as test_client:
        yield test_client


@pytest.fixture
def client(app_state):
    return app_state


@pytest.fixture
def recorder(client):
    """Swap in the recording repository for the duration of one test."""
    state = client.app.state.tlsoc
    # ``AppState.cases`` is a read-only property over the real/demo pair; the recorder
    # replaces the REAL store it resolves to.
    original = state._real_cases
    rec = RecordingCases()
    state._real_cases = rec
    yield rec
    state._real_cases = original


# --------------------------------------------------------------------------- #
# (G) Regression: a request that sends none of the new parameters is untouched.
# --------------------------------------------------------------------------- #
def test_a_request_with_no_new_parameters_gets_the_unchanged_envelope(client) -> None:
    """The legacy envelope, key for key.

    The echoes are answers to questions this caller did not ask, and emitting them as
    nulls would rewrite the response of every existing client to announce a feature none
    of them use.
    """
    body = client.get("/api/cases", params={"limit": 5}).json()
    assert set(body) == {"cases", "total", "window_total_exact"}

    windowed = client.get("/api/cases", params={"limit": 5, "from": "now-30d"}).json()
    assert set(windowed) == {"cases", "total", "window_total_exact"}


def test_the_legacy_request_still_takes_the_default_sort_into_the_store(recorder, client) -> None:
    client.get("/api/cases", params={"limit": 5})
    assert recorder.list_calls[-1]["sort_field"] == CASE_SORT_FIELDS[0]
    assert recorder.list_calls[-1]["sort_order"] == CASE_SORT_ORDERS[0]
    # Nothing about the group reaches a repository that was never asked for one: a
    # third-party override of the non-abstract ``list_window`` predates the keyword.
    client.get("/api/cases", params={"limit": 5, "from": "now-30d"})
    assert "status_group" not in recorder.window_calls[-1]


# --------------------------------------------------------------------------- #
# (H) Server-side sort.
# --------------------------------------------------------------------------- #
def test_sort_reaches_both_the_windowed_and_the_unwindowed_store_call(recorder, client) -> None:
    client.get("/api/cases", params={"sort_field": "risk_score", "sort_order": "asc"})
    assert recorder.list_calls[-1]["sort_field"] == "risk_score"
    assert recorder.list_calls[-1]["sort_order"] == "asc"

    client.get(
        "/api/cases",
        params={"sort_field": "risk_score", "sort_order": "asc", "from": "now-30d"},
    )
    assert recorder.window_calls[-1]["sort_field"] == "risk_score"
    assert recorder.window_calls[-1]["sort_order"] == "asc"


@pytest.mark.parametrize(
    "rejected",
    [
        # A mapped ``text`` field: real Elasticsearch refuses to sort on one without
        # fielddata, so this would be a 400 from the cluster surfacing as a 500 here.
        "title",
        # A field the SQL repository does not recognise, which it answers in created_at
        # order without saying so.
        "confidence",
        # Not a field at all — the shape an injected query-document key would take.
        "_doc",
        "",
    ],
)
def test_a_sort_field_outside_the_allow_list_never_reaches_a_store(
    recorder, client, rejected: str
) -> None:
    """Enforced at the ROUTE, above both stores.

    The Elasticsearch store interpolates the field name into the query document as a KEY,
    which no escaping can make safe after the fact, and the in-memory client accepts ANY
    key and resolves an unplaceable value to a sentinel — so an allow-list asserted only
    against the offline double would pass here and 400 in production.
    """
    res = client.get("/api/cases", params={"sort_field": rejected})
    # A sort is a presentation preference: an unsupported one is answered in the default
    # order rather than refused, and the echo is what keeps that honest.
    assert res.status_code == 200
    assert recorder.list_calls[-1]["sort_field"] == CASE_SORT_FIELDS[0]
    assert res.json()["sort_field"] == CASE_SORT_FIELDS[0]


@pytest.mark.parametrize("rejected", ["DESC", "ascending", "1", "", "; drop"])
def test_a_sort_order_outside_the_two_directions_falls_back(recorder, client, rejected) -> None:
    res = client.get("/api/cases", params={"sort_field": "risk_score", "sort_order": rejected})
    assert res.status_code == 200
    assert recorder.list_calls[-1]["sort_order"] == CASE_SORT_ORDERS[0]
    assert res.json()["sort_order"] == CASE_SORT_ORDERS[0]


def test_the_response_echoes_the_sortable_set_and_the_effective_limit(client) -> None:
    body = client.get(
        "/api/cases",
        params={"sort_field": "risk_score", "limit": CASE_PAGE_LIMIT * 5},
    ).json()
    assert body["sortable_fields"] == list(CASE_SORT_FIELDS)
    # The clamp emits no error and no header, so without this echo a client that asked
    # for more than the server serves cannot tell a CLAMP from a small result set.
    assert body["limit_applied"] == CASE_PAGE_LIMIT
    assert body["offset_applied"] == 0
    assert body["max_offset"] == CASE_RESULT_WINDOW - CASE_PAGE_LIMIT


@pytest.mark.asyncio
async def test_every_allow_listed_sort_orders_both_bundled_backends(repo) -> None:
    """A real ordering, not merely an accepted parameter."""
    for field in CASE_SORT_FIELDS:
        descending, _total = await repo.list(sort_field=field, sort_order="desc", limit=CORPUS)
        ascending, _total = await repo.list(sort_field=field, sort_order="asc", limit=CORPUS)
        assert [c.case_id for c in descending] != [c.case_id for c in ascending]
        keys = [getattr(c, field) for c in descending]
        assert keys == sorted(keys, reverse=True)


# --------------------------------------------------------------------------- #
# (H) The tiebreaker, asserted on the emitted SHAPE.
# --------------------------------------------------------------------------- #
def test_elasticsearch_sort_always_ends_with_a_unique_tiebreaker() -> None:
    """Asserted on the emitted sort ARRAY, never on observed rows.

    Tie behaviour cannot be reproduced offline: the in-memory client sorts with Python's
    STABLE sort, so equal keys keep insertion order there and the defect is invisible. On
    a real cluster the order among equal keys is resolved per shard and is not obliged to
    be the same on the next search, so ``from``/``size`` paging over a tied key repeats
    and skips rows.
    """
    for field in CASE_SORT_FIELDS:
        for order in CASE_SORT_ORDERS:
            clause = case_sort_clause(field, order)
            assert len(clause) == 2
            assert list(clause[0]) == [field]
            assert list(clause[1]) == [CASE_SORT_TIEBREAKER]
            assert clause[0][field]["order"] == order
            assert clause[1][CASE_SORT_TIEBREAKER]["order"] == order
    # Sorting BY the tiebreaker does not repeat it.
    assert len(case_sort_clause(CASE_SORT_TIEBREAKER, "desc")) == 1


def test_sql_order_by_always_ends_with_the_primary_key() -> None:
    """Same contract, same reason: SQLite usually falls back to rowid order offline."""
    for field in CASE_SORT_FIELDS:
        for order in CASE_SORT_ORDERS:
            terms = _case_order_by(field, order)
            assert len(terms) == 2
            rendered = str(terms[-1])
            assert CASE_SORT_TIEBREAKER in rendered
            assert ("DESC" in rendered) is (order == "desc")


@pytest.mark.asyncio
async def test_the_tiebreaker_is_actually_emitted_by_both_store_methods(now) -> None:
    """The clause builder is not merely available — both listings use it."""

    class SpyES(InMemoryESClient):
        def __init__(self) -> None:
            super().__init__()
            self.bodies: list[dict[str, Any]] = []

        async def search(self, index: str, body: dict[str, Any]) -> dict[str, Any]:
            self.bodies.append(body)
            return await super().search(index, body)

    spy = SpyES()
    store = CaseStore(spy)
    await _seed(store, _corpus(now)[:2])
    spy.bodies.clear()

    await store.list(limit=1, sort_field="risk_score", sort_order="desc")
    await store.list_window(created_from="now-30d", limit=1, sort_field="risk_score")
    listings = [b for b in spy.bodies if "sort" in b and isinstance(b["sort"], list)]
    assert len(listings) >= 2
    for body in listings[-2:]:
        assert len(body["sort"]) == 2
        assert list(body["sort"][-1]) == [CASE_SORT_TIEBREAKER]


# --------------------------------------------------------------------------- #
# (I) Offset bounds.
# --------------------------------------------------------------------------- #
def test_offset_is_lower_bounded_at_zero(recorder, client) -> None:
    """Real Elasticsearch rejects a negative ``from``; the in-memory client slices from
    the END of the result and hands back plausible WRONG rows. Neither is acceptable, and
    only one of them is visible offline."""
    res = client.get("/api/cases", params={"offset": -25})
    assert res.status_code == 200
    assert recorder.list_calls[-1]["offset"] == 0
    # The clamp is applied to every caller; only the ECHO of it is opt-in, because a
    # caller that engaged none of the new parameters must get its old envelope back.
    assert "offset_applied" not in res.json()
    echoed = client.get(
        "/api/cases", params={"offset": -25, "sort_field": CASE_SORT_FIELDS[0]},
    ).json()
    assert echoed["offset_applied"] == 0


def test_a_page_past_the_result_window_is_refused_with_a_legible_reason(client) -> None:
    res = client.get("/api/cases", params={"limit": CASE_PAGE_LIMIT, "offset": CASE_RESULT_WINDOW})
    assert res.status_code == 400
    detail = res.json()["detail"]
    assert str(CASE_RESULT_WINDOW) in detail
    assert "result window" in detail
    # The boundary itself is served, so the refusal is a ceiling and not an off-by-one.
    ok = client.get(
        "/api/cases",
        params={
            "limit": CASE_PAGE_LIMIT,
            "offset": CASE_RESULT_WINDOW - CASE_PAGE_LIMIT,
            "sort_field": "created_at",
        },
    )
    assert ok.status_code == 200
    assert ok.json()["offset_applied"] == CASE_RESULT_WINDOW - CASE_PAGE_LIMIT


def test_the_result_window_constant_is_the_elasticsearch_default() -> None:
    """The bound is NAMED, with a stated basis, rather than discovered as a 400.

    Same default this repository already pins for the LOG read path, so the two paging
    ceilings cannot drift apart.
    """
    from app.connectors.elastic import _MAX_RESULT_WINDOW

    assert CASE_RESULT_WINDOW == _MAX_RESULT_WINDOW == 10_000


# --------------------------------------------------------------------------- #
# (J) The scalar status GROUP.
# --------------------------------------------------------------------------- #
def test_the_groups_are_the_products_own_status_constants() -> None:
    """Resolved server-side from the lifecycle taxonomy, never a restated list."""
    assert CASE_STATUS_GROUPS["active"] == OPEN_CASE_STATUSES
    assert CASE_STATUS_GROUPS["terminal"] == TERMINAL_CASE_STATUSES
    # ``active`` rather than ``open``: ``open`` is also one concrete status value, and a
    # group whose name collides with a member of the vocabulary it groups is a trap.
    assert "open" not in CASE_STATUS_GROUPS
    assert set(CASE_STATUS_GROUPS["active"]).isdisjoint(CASE_STATUS_GROUPS["terminal"])


@pytest.mark.parametrize("group", sorted(CASE_STATUS_GROUPS))
@pytest.mark.asyncio
async def test_both_bundled_stores_push_the_group_down_and_agree_with_python(
    repo, group: str
) -> None:
    statuses = status_group_statuses(group)
    assert statuses is not None
    pushed, total, _exact = await repo.list_window(status_group=group, limit=CORPUS)
    everything, _t = await repo.list(limit=CORPUS)
    expected = [c.case_id for c in everything if case_in_status_group(c, statuses)]
    assert sorted(c.case_id for c in pushed) == sorted(expected)
    assert total == len(expected)
    assert 0 < total < CORPUS


@pytest.mark.asyncio
async def test_the_group_composes_with_the_window_on_both_backends(repo, now) -> None:
    _rows, total, exact = await repo.list_window(
        created_from=_iso(now - timedelta(days=1)),
        status_group="active",
        limit=CORPUS,
    )
    _all_active, active_total, _e = await repo.list_window(status_group="active", limit=CORPUS)
    assert exact is True
    assert total == active_total  # the whole corpus is inside the window


@pytest.mark.asyncio
async def test_a_repository_with_only_the_abstract_surface_survives_the_group() -> None:
    """No keyword was added to the abstract ``CaseRepository.list``.

    A third-party repository implements only the abstract methods; adding a keyword there
    would break every one of them with a ``TypeError``. The group is an explicit named
    parameter on the non-abstract ``list_window``, consumed there, and the compatibility
    path filters it in Python — reporting the result as NOT exact even though no time
    window was requested, which is a state the console has to be able to read.
    """

    class MinimalRepo(CaseRepository):
        def __init__(self, rows: list[Case]) -> None:
            self._rows = rows

        async def save(self, case: Case) -> None: ...

        async def get(self, case_id: str) -> Case | None:
            return next((c for c in self._rows if c.case_id == case_id), None)

        async def find_open_by_signature(self, signature: str) -> Case | None:
            return None

        async def list(
            self, *, status=None, source_surface=None, entity_value=None,
            limit=50, offset=0, sort_field="created_at", sort_order="desc",
        ) -> tuple[list[Case], int]:
            return self._rows[offset: offset + limit], len(self._rows)

        async def list_scans(self, limit: int = 50) -> tuple[list[Case], int]:
            return [], 0

        async def count_new_scans(self, since_iso: str) -> int:
            return 0

    rows = _corpus(datetime.now(timezone.utc))
    repo = MinimalRepo(rows)
    page, total, exact = await repo.list_window(status_group="terminal", limit=CORPUS)
    statuses = status_group_statuses("terminal")
    assert total == sum(1 for c in rows if case_in_status_group(c, statuses))
    assert all(case_in_status_group(c, statuses) for c in page)
    # Windowless AND not exact — the state that must never render as a complete page.
    assert exact is False


def test_an_unknown_group_is_rejected(client) -> None:
    res = client.get("/api/cases", params={"status_group": "everything"})
    assert res.status_code == 400
    assert "status_group" in res.json()["detail"]
    for name in CASE_STATUS_GROUPS:
        assert client.get("/api/cases", params={"status_group": name}).status_code == 200


def test_the_group_and_a_single_status_together_are_rejected(client) -> None:
    """They answer the same question with different arities; applying both would either
    empty the list whenever the status sits outside the group or silently pick a winner,
    and a caller can predict neither from the request."""
    res = client.get(
        "/api/cases",
        params={"status_group": "active", "status": CaseStatus.CLOSED.value},
    )
    assert res.status_code == 400
    assert "mutually exclusive" in res.json()["detail"]


def test_a_group_request_echoes_what_was_applied(client) -> None:
    body = client.get("/api/cases", params={"status_group": "terminal", "limit": 5}).json()
    assert body["status_group_applied"] == "terminal"
    statuses = status_group_statuses("terminal")
    assert statuses is not None
    assert all(c["status"] in statuses for c in body["cases"])


def test_a_group_request_routes_through_the_windowed_call_even_with_no_window(
    recorder, client
) -> None:
    """The group is a store push-down, so it cannot be honoured by the plain listing."""
    client.get("/api/cases", params={"status_group": "active"})
    assert recorder.list_calls == []
    assert recorder.window_calls[-1]["status_group"] == "active"


# --------------------------------------------------------------------------- #
# Paging actually walks the population.
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_contiguous_offset_pages_cover_the_population_exactly_once(repo) -> None:
    seen: list[str] = []
    page_size = 7
    for offset in range(0, CORPUS, page_size):
        rows, total, _exact = await repo.list_window(
            status_group="active",
            limit=page_size,
            offset=offset,
            sort_field="risk_score",
            sort_order="desc",
        )
        seen.extend(c.case_id for c in rows)
        if offset + page_size >= total:
            break
    assert len(seen) == len(set(seen)), "a row was served on two pages"
    _rows, expected_total, _e = await repo.list_window(status_group="active", limit=CORPUS)
    assert len(seen) == expected_total
