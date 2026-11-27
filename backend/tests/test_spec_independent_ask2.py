"""SPEC-DERIVED, implementation-blind tests for ASK 2 (KPI drill-down depth, server half).

Written from ``tmp/SPEC.md`` alone, without reading ``app/api/routes.py``,
``app/stores/base.py``, ``app/stores/cases.py`` or ``app/stores/sql/repositories.py``.
Names were discovered by CALLING the endpoint (its own OpenAPI document and its own
responses) and by ``inspect`` at runtime — including the abstract repository contract,
which B25's minimal double is GENERATED from rather than transcribed, so the double
cannot drift away from the interface it is meant to represent.

The dangerous half of this ask is that the drill-down now pushes sorting, paging and a
status GROUP down into two stores with very different failure modes: the Elasticsearch
store interpolates a sort field into query DSL, and the SQL store derives a column. A
wrong implementation of any criterion below is SILENT — a sort that never reaches the
store, a page that repeats rows, a facet that quietly matches nothing, an exactness
flag that has been squashed into a boolean.
"""

from __future__ import annotations

import inspect
from contextlib import asynccontextmanager
from typing import Any

import pytest
import pytest_asyncio
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import event

from app.api.routes import router
from app.config import Secrets
from app.constants import (
    OPEN_CASE_STATUSES,
    TERMINAL_CASE_STATUSES,
    CaseStatus,
    EntityType,
    SourceSurface,
    Verdict,
)
from app.es.fake import InMemoryESClient
from app.constants import CASES_INDEX
from app.es.indices import CONTRACT_INDICES
from app.llm.providers import MockProvider
from app.models import Case, Entity, EvidenceItem
from app.state import AppState
from app.stores.base import CaseRepository
from app.stores.cases import CaseStore
from app.stores.sql import SqlCaseRepository, build_async_engine, create_all

# Sort types Elasticsearch can order on directly. ``text`` is deliberately absent: an
# analysed field has no doc values, so sorting on it fails at query time — exactly the
# class of bug B12 exists to keep out of the allowlist.
_SORTABLE_ES_TYPES = {"date", "keyword", "float", "double", "integer", "long", "short", "boolean"}


def _case(
    case_id: str,
    *,
    status: CaseStatus = CaseStatus.NEW,
    created_at: str = "2026-02-01T00:00:00Z",
    updated_at: str | None = None,
    risk_score: float = 1.0,
) -> Case:
    return Case(
        case_id=case_id,
        cluster_signature=f"sig:{case_id}",
        source_surface=SourceSurface.AUTOMATED_SCAN,
        entity=Entity(type=EntityType.HOST, value="host-a"),
        rule_ids=["rule-a"],
        verdict=Verdict.FALSE_POSITIVE,
        confidence=0.5,
        risk_score=risk_score,
        status=status,
        created_at=created_at,
        updated_at=updated_at or created_at,
        evidence=[EvidenceItem(summary="Recurring low-value pattern")],
        recommended_action="No action required.",
    )


# --------------------------------------------------------------------------- #
# A client that RECORDS what each store call actually received.
#
# B11 is unsatisfiable from the HTTP status alone: a route that returns 200 while
# handing an attacker-chosen field to the store has failed the criterion and looks
# identical from outside. Every sort/paging test below therefore asserts on the
# recorded store arguments, not on the response.
# --------------------------------------------------------------------------- #
class _StoreCalls:
    def __init__(self) -> None:
        self.list: list[dict[str, Any]] = []
        self.list_window: list[dict[str, Any]] = []

    def reset(self) -> None:
        self.list.clear()
        self.list_window.clear()

    @property
    def all(self) -> list[dict[str, Any]]:
        return self.list + self.list_window


@pytest.fixture
def api_client(secrets: Secrets, mock_provider: MockProvider):
    calls = _StoreCalls()
    holder: dict[str, AppState] = {}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        overrides = {"anthropic": mock_provider, "openai": mock_provider, "mock": mock_provider}
        state = AppState.create(
            secrets=secrets, es=InMemoryESClient(), provider_overrides=overrides
        )
        await state.startup(start_poller=False)
        await state.update_prefs(state.prefs.model_copy(update={"setup_complete": True}))
        real_list = state.cases.list
        real_window = state.cases.list_window

        async def _list(**kwargs: Any):
            calls.list.append(dict(kwargs))
            return await real_list(**kwargs)

        async def _window(**kwargs: Any):
            calls.list_window.append(dict(kwargs))
            return await real_window(**kwargs)

        state.cases.list = _list  # type: ignore[assignment]
        state.cases.list_window = _window  # type: ignore[assignment]
        app.state.tlsoc = state
        holder["state"] = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    api.include_router(router)
    with TestClient(api) as client:
        yield client, calls, holder["state"]


@pytest_asyncio.fixture
async def sql_repo():
    engine = build_async_engine("sqlite+aiosqlite:///:memory:")
    await create_all(engine)
    repo = SqlCaseRepository(engine)
    yield repo, engine
    await engine.dispose()


def _allowlist(client: TestClient) -> list[str]:
    """The effective sort allowlist, read off the ECHO the response publishes (B14).

    Deliberately not a literal: a deployment with a different sortable set must make
    every test below exercise ITS set, which is the whole point of echoing it.
    """
    body = client.get("/api/cases?sort_order=desc").json()
    fields = body["sortable_fields"]
    assert isinstance(fields, list) and fields, "the response must echo a non-empty allowlist"
    return [str(f) for f in fields]


# =========================================================================== #
# B10 / B11 — the allowlist is enforced AT THE ROUTE, above both stores
# =========================================================================== #
def test_b11_out_of_allowlist_sort_field_never_reaches_the_store(api_client) -> None:
    """B11. Catches: an allowlist enforced in the SQL store only.

    The ES store interpolates the sort field straight into query DSL, so a field that
    reaches it is a field that reaches the query. Asserting only on the HTTP status
    would pass against exactly that bug, so this asserts on what the STORE received —
    and it must be the DEFAULT, not the caller's string, and not omitted.
    """
    client, calls, _state = api_client
    allowed = set(_allowlist(client))
    default_field = client.get("/api/cases?sort_order=desc").json()["sort_field"]
    assert default_field in allowed

    for hostile in ("case_id.keyword", "../etc", "history.note", "_script", "entity.value"):
        assert hostile not in allowed, "fixture must probe fields that are NOT allowlisted"
        calls.reset()
        response = client.get(f"/api/cases?sort_field={hostile}")

        # Falls back rather than erroring (B11).
        assert response.status_code == 200
        assert response.json()["sort_field"] == default_field
        assert calls.all, "the request must still have reached a store"
        for received in calls.all:
            assert received["sort_field"] == default_field
            assert received["sort_field"] != hostile


def test_b11_sort_order_is_allowlisted_to_the_two_directions(api_client) -> None:
    """B11. Catches: a direction string interpolated into the query.

    An unknown direction must fall back, and the only two values the store may ever be
    handed are the two the endpoint itself round-trips.
    """
    client, calls, _state = api_client
    accepted: set[str] = set()
    for candidate in ("asc", "desc", "ASC", "sideways", "asc; drop", ""):
        calls.reset()
        response = client.get(f"/api/cases?sort_field=risk_score&sort_order={candidate}")
        assert response.status_code == 200
        echoed = response.json()["sort_order"]
        accepted.add(echoed)
        for received in calls.all:
            assert received["sort_order"] == echoed

    assert len(accepted) == 2, f"exactly two directions may survive, got {sorted(accepted)}"


def test_b10_sort_forwards_to_both_the_windowed_and_the_unwindowed_call(api_client) -> None:
    """B10. Catches: sorting wired into one of the two code paths.

    The panel uses the unwindowed call for window-exempt populations and the windowed
    one for everything else; a sort wired into only one silently reorders half the
    tiles and leaves the rest alone.
    """
    client, calls, _state = api_client
    field = _allowlist(client)[-1]

    calls.reset()
    assert client.get(f"/api/cases?sort_field={field}&sort_order=asc").status_code == 200
    assert calls.list and not calls.list_window
    assert calls.list[0]["sort_field"] == field and calls.list[0]["sort_order"] == "asc"

    calls.reset()
    windowed = client.get(
        f"/api/cases?from=2026-01-01T00:00:00Z&to=2026-12-31T00:00:00Z"
        f"&sort_field={field}&sort_order=asc"
    )
    assert windowed.status_code == 200
    assert calls.list_window and not calls.list
    assert calls.list_window[0]["sort_field"] == field
    assert calls.list_window[0]["sort_order"] == "asc"


def test_b14_b15_the_response_echoes_the_effective_sort_and_the_effective_limit(
    api_client,
) -> None:
    """B14 + B15. Catches: a client that cannot tell a clamp from a small result set.

    The panel builds its sort menu from the echo, so the echo has to be the truth the
    store was actually given — including a limit the server silently reduced.
    """
    client, calls, _state = api_client
    field = _allowlist(client)[0]

    calls.reset()
    body = client.get(f"/api/cases?sort_field={field}&limit=100000").json()

    assert body["sort_field"] == field
    assert set(body["sortable_fields"]) == set(_allowlist(client))
    received = calls.all[0]
    # The clamp is visible, and the echoed number is the one the store was handed.
    assert body["limit_applied"] == received["limit"]
    assert body["limit_applied"] < 100000


def test_b9_a_request_with_none_of_the_new_parameters_is_unchanged(api_client) -> None:
    """B9. Catches: an additive feature that changes an existing response shape.

    The pre-existing consumers of this endpoint send none of the new parameters; adding
    keys to their response is a wire change nobody asked for.
    """
    client, _calls, _state = api_client
    plain = client.get("/api/cases").json()
    assert set(plain) == {"cases", "total", "window_total_exact"}


# =========================================================================== #
# B16 / B17 — the paging boundary
# =========================================================================== #
def test_b16_offset_is_lower_bounded_at_zero_at_the_route(api_client) -> None:
    """B16. Catches: a negative offset reaching the store.

    A negative ``from`` is an error in Elasticsearch and a silently different query in
    SQL; the route is the only place both are covered at once.
    """
    client, calls, _state = api_client
    for offset in (-1, -50, -100000):
        calls.reset()
        response = client.get(f"/api/cases?offset={offset}")
        assert response.status_code == 200
        assert calls.all
        for received in calls.all:
            assert received["offset"] == 0


def test_b17_crossing_the_result_window_is_refused_legibly_not_as_a_backend_error(
    api_client,
) -> None:
    """B17. Catches: deep paging surfacing as a 500 from the search backend.

    The ceiling is DERIVED from the endpoint's own echo (``max_offset`` for a given
    limit) rather than written down here, so a deployment that raises the bound keeps
    this test meaningful. One offset inside the bound must work; one past it must be
    refused with a reason a person can read, and must never reach a store.
    """
    client, calls, _state = api_client
    limit = 50
    echo = client.get(f"/api/cases?sort_order=desc&limit={limit}").json()
    max_offset = int(echo["max_offset"])
    assert max_offset > 0

    calls.reset()
    inside = client.get(f"/api/cases?limit={limit}&offset={max_offset}")
    assert inside.status_code == 200, "the deepest permitted offset must be reachable"
    assert calls.all and calls.all[0]["offset"] == max_offset

    calls.reset()
    past = client.get(f"/api/cases?limit={limit}&offset={max_offset + 1}")
    assert past.status_code == 400, "crossing the bound must be refused, not attempted"
    detail = str(past.json()["detail"])
    # Legible: it names the offset asked for, the bound, and the deepest usable offset.
    assert str(max_offset + 1) in detail
    assert str(max_offset) in detail
    assert calls.all == [], "a refused request must never reach a store"

    # The bound is a property of the endpoint, not of one limit: a bigger page reaches
    # a shallower deepest-offset, and the two agree on the underlying row ceiling.
    bigger = int(client.get("/api/cases?sort_order=desc&limit=200").json()["max_offset"])
    assert bigger < max_offset
    assert bigger + 200 == max_offset + limit


# =========================================================================== #
# B27 — the group parameter's refusals
# =========================================================================== #
def test_b27_unknown_group_and_group_plus_status_are_both_rejected(api_client) -> None:
    """B27. Catches: an unknown group silently degrading to "no filter".

    A facet that quietly matches everything is worse than an error: the operator reads
    an unfiltered page as a filtered one. And a group AND a single status together are
    two different questions; answering one of them silently is a lie about which.
    """
    client, calls, _state = api_client

    calls.reset()
    unknown = client.get("/api/cases?status_group=not_a_group")
    assert unknown.status_code == 400
    assert calls.all == []

    # The rejection names what IS accepted, so the message is actionable.
    detail = str(unknown.json()["detail"])
    accepted = [g for g in ("active", "terminal") if g in detail]
    assert accepted, f"the refusal must name the accepted groups; got {detail!r}"

    for group in accepted:
        calls.reset()
        ok = client.get(f"/api/cases?status_group={group}")
        assert ok.status_code == 200, f"{group} must be accepted"
        assert ok.json()["status_group_applied"] == group

        calls.reset()
        both = client.get(f"/api/cases?status_group={group}&status={CaseStatus.NEW.value}")
        assert both.status_code == 400
        assert calls.all == []


# =========================================================================== #
# B25 — the abstract contract is not widened
# =========================================================================== #
def _minimal_repository() -> tuple[type, list[Case]]:
    """GENERATE a repository implementing ONLY ``CaseRepository``'s abstract methods.

    Generated from ``__abstractmethods__`` + ``inspect.signature`` rather than
    transcribed, so it is by construction the smallest legal implementation *of the
    interface as it stands*. A keyword added to the abstract ``list`` would appear here
    automatically; a keyword the windowed helper forwards but the abstract method does
    not declare shows up as a ``TypeError``, which is exactly B25's failure mode for a
    third-party or future store.
    """
    stored: list[Case] = []
    namespace: dict[str, Any] = {}

    async def _list(self, **kwargs: Any):  # type: ignore[no-untyped-def]
        limit = int(kwargs.get("limit") or 50)
        offset = max(0, int(kwargs.get("offset") or 0))
        return stored[offset : offset + limit], len(stored)

    async def _save(self, case: Case) -> None:  # type: ignore[no-untyped-def]
        stored.append(case)

    for name in sorted(CaseRepository.__abstractmethods__):
        signature = inspect.signature(getattr(CaseRepository, name))
        if name == "list":
            # Bound to the DECLARED signature so an undeclared keyword raises.
            exec(  # noqa: S102 - generating the exact declared signature is the point
                f"async def _declared{signature}: return await _list(self, "
                + ", ".join(
                    f"{p}={p}" for p in list(signature.parameters)[1:]
                )
                + ")",
                {"_list": _list, "Case": Case, "Any": Any},
                namespace,
            )
            namespace["list"] = namespace.pop("_declared")
        elif name == "save":
            namespace["save"] = _save
        else:

            async def _stub(self, *args: Any, __n: str = name, **kwargs: Any):  # type: ignore[no-untyped-def]
                raise AssertionError(f"the windowed call must not need {__n}()")

            namespace[name] = _stub

    return type("MinimalCaseRepository", (CaseRepository,), namespace), stored


async def test_b25_a_minimal_repository_survives_the_windowed_group_call(
) -> None:
    """B25. Catches: a group keyword added to the abstract repository contract.

    The base ``list_window`` helper is what a store that does not implement a real
    push-down falls back to. If it forwarded ``status_group`` on to ``list``, every
    third-party repository — and the minimal one below — would raise ``TypeError`` on
    the first faceted request. It must be popped, and the answer must be reported as
    NOT exact, because a helper that filtered nothing cannot honestly claim it did.
    """
    assert "status_group" not in inspect.signature(CaseRepository.list).parameters, (
        "the group must not widen the abstract contract"
    )

    repo_type, stored = _minimal_repository()
    repo = repo_type()
    for i, status in enumerate(list(OPEN_CASE_STATUSES) + list(TERMINAL_CASE_STATUSES)):
        stored.append(_case(f"m-{i:03d}", status=CaseStatus(status)))

    cases, total, exact = await repo.list_window(
        created_from="2026-01-01T00:00:00Z",
        created_to="2026-12-31T00:00:00Z",
        status_group="terminal",
        limit=50,
        offset=0,
        sort_field="created_at",
        sort_order="desc",
    )

    assert isinstance(cases, list)
    assert isinstance(total, int)
    # The honest answer: this backend did not narrow anything, and says so.
    assert exact is not True, "a fallback that filtered nothing may not claim exactness"


# =========================================================================== #
# B26 — both bundled stores implement the REAL push-down
# =========================================================================== #
@pytest.mark.parametrize("group", ["active", "terminal"])
async def test_b26_both_bundled_stores_agree_with_an_in_python_filter(
    sql_repo, group: str
) -> None:
    """B26. Catches: a push-down implemented on one backend and faked on the other.

    The oracle is an in-Python filter over the PRODUCT'S OWN status constants, so the
    expected set is derived from the same source of truth the stores must be using. Any
    store that hardcodes its own list, or that matches a comma-joined string, disagrees
    immediately.
    """
    sql, _engine = sql_repo
    es = CaseStore(InMemoryESClient())

    every_status = list(OPEN_CASE_STATUSES) + list(TERMINAL_CASE_STATUSES)
    assert set(every_status) == {s.value for s in CaseStatus}, (
        "the two constants must partition the status vocabulary"
    )
    corpus = [
        _case(f"g-{i:03d}", status=CaseStatus(status), created_at=f"2026-02-0{(i % 8) + 1}T00:00:00Z")
        for i, status in enumerate(every_status * 2)
    ]
    for case in corpus:
        await sql.save(case)
        await es.save(case)

    wanted = set(OPEN_CASE_STATUSES if group == "active" else TERMINAL_CASE_STATUSES)
    expected = sorted(c.case_id for c in corpus if c.status.value in wanted)
    assert expected, "the fixture must actually populate this group"
    assert len(expected) < len(corpus), "the group must actually narrow something"

    for label, repo in (("sql", sql), ("es", es)):
        cases, total, exact = await repo.list_window(
            created_from="2026-01-01T00:00:00Z",
            created_to="2026-12-31T00:00:00Z",
            status_group=group,
            limit=len(corpus) * 2,
        )
        assert sorted(c.case_id for c in cases) == expected, f"{label} disagrees"
        # A real push-down knows the TRUE total, not the page length.
        assert total == len(expected), f"{label} reported {total}"
        assert exact is True, f"{label} did not claim a real push-down"


# =========================================================================== #
# B12 / B13 — sortability and the unique tiebreaker, on BOTH bundled stores
# =========================================================================== #
async def test_b12_every_allowlisted_field_is_sortable_on_both_bundled_backends(
    api_client, sql_repo
) -> None:
    """B12. Catches: an allowlist entry that is unsortable on one backend.

    The in-memory double accepts any key and orders by it, so a test written against it
    passes vacuously. This checks (a) the REAL Elasticsearch mapping declares each
    allowlisted field with a type that has doc values, and (b) the REAL SQL engine
    actually reverses the row order between the two directions — which a column
    derivation that silently no-ops cannot do.
    """
    client, _calls, _state = api_client
    fields = _allowlist(client)
    sql, _engine = sql_repo
    es = CaseStore(InMemoryESClient())

    mapping = CONTRACT_INDICES[CASES_INDEX]["properties"]
    for field in fields:
        assert field in mapping, f"{field} is allowlisted but unmapped"
        declared = str(mapping[field].get("type"))
        assert declared in _SORTABLE_ES_TYPES, f"{field} is mapped as {declared}, which cannot sort"

    corpus = [
        _case(
            f"s-{i:03d}",
            created_at=f"2026-02-{i + 1:02d}T00:00:00Z",
            updated_at=f"2026-03-{i + 1:02d}T00:00:00Z",
            risk_score=float(i) * 3.5,
        )
        for i in range(5)
    ]
    for case in corpus:
        await sql.save(case)
        await es.save(case)

    for label, repo in (("sql", sql), ("es", es)):
        for field in fields:
            ascending, _total = await repo.list(sort_field=field, sort_order="asc", limit=50)
            descending, _total = await repo.list(sort_field=field, sort_order="desc", limit=50)
            asc_ids = [c.case_id for c in ascending]
            desc_ids = [c.case_id for c in descending]
            assert len(asc_ids) == len(corpus)
            assert asc_ids == list(reversed(desc_ids)), (
                f"{label} does not really order by {field}"
            )


async def test_b13_a_unique_tiebreaker_is_appended_in_both_bundled_stores(
    api_client, sql_repo
) -> None:
    """B13. Catches: offset paging that repeats and skips rows under ties.

    Tie behaviour is NOT reproducible offline — the fake ES sorts stably and SQLite is
    usually rowid-ordered — so a row-order assertion here would pass against a store
    with no tiebreaker at all. This asserts the emitted sort SHAPE instead: the sort
    array Elasticsearch is handed, and the ORDER BY terms SQLAlchemy compiles. Both
    must end on a field that is UNIQUE per case, in the same direction.
    """
    client, _calls, _state = api_client
    fields = _allowlist(client)

    # --- Elasticsearch: the sort array in the query DSL --------------------------- #
    es_client = InMemoryESClient()
    es = CaseStore(es_client)
    emitted: list[list[Any]] = []
    real_search = es_client.search

    async def _record(index: str, body: dict[str, Any]) -> dict[str, Any]:
        if "sort" in body:
            emitted.append(body["sort"])
        return await real_search(index, body)

    es_client.search = _record  # type: ignore[assignment]

    # --- SQL: the compiled ORDER BY ----------------------------------------------- #
    sql, engine = sql_repo
    statements: list[str] = []

    @event.listens_for(engine.sync_engine, "before_cursor_execute")
    def _capture(conn, cursor, statement, params, context, executemany):  # type: ignore[no-untyped-def]
        statements.append(statement)

    mapping = CONTRACT_INDICES[CASES_INDEX]["properties"]
    unique_candidates = {
        name for name, spec in mapping.items() if str(spec.get("type")) == "keyword"
    }

    for field in fields:
        for order in ("asc", "desc"):
            emitted.clear()
            await es.list(sort_field=field, sort_order=order, limit=10)
            assert emitted, "the ES store must emit an explicit sort"
            sort_array = emitted[-1]
            assert len(sort_array) >= 2, f"no tiebreaker after {field} ({order})"
            primary, tiebreaker = sort_array[0], sort_array[-1]
            assert list(primary) == [field]
            (tie_field,) = list(tiebreaker)
            assert tie_field != field
            assert tie_field in unique_candidates, (
                f"{tie_field} is not a unique keyword field, so it cannot break ties"
            )
            assert tiebreaker[tie_field]["order"] == order, (
                "a tiebreaker running the other way reorders ties between pages"
            )

            statements.clear()
            await sql.list(sort_field=field, sort_order=order, limit=10)
            ordered = [s for s in statements if "ORDER BY" in s]
            assert ordered, "the SQL store must emit an explicit ORDER BY"
            clause = ordered[-1].split("ORDER BY", 1)[1]
            terms = [t.strip() for t in clause.split("LIMIT", 1)[0].split(",")]
            assert len(terms) >= 2, f"no ORDER BY tiebreaker after {field} ({order})"
            assert tie_field in terms[-1], (
                f"the SQL tiebreaker must be the same unique field: {terms[-1]!r}"
            )
            assert terms[-1].upper().endswith(order.upper())


# =========================================================================== #
# B32 — the exactness flag stays three-valued
# =========================================================================== #
def test_b32_the_exactness_flag_is_not_collapsed_to_a_boolean(api_client) -> None:
    """B32. Catches: ``window_total_exact or False``.

    Three states carry three different meanings: the total is exact; the total is a
    lower bound (B25's fallback path produces exactly this); and the question does not
    apply because the request was not windowed. Collapsing the last two makes a
    windowless request render as a complete page.
    """
    client, _calls, state = api_client

    unwindowed = client.get("/api/cases").json()
    assert unwindowed["window_total_exact"] is None, (
        "an unwindowed request has no windowed total; None is not False"
    )

    windowed = client.get(
        "/api/cases?from=2026-01-01T00:00:00Z&to=2026-12-31T00:00:00Z"
    ).json()
    assert windowed["window_total_exact"] is True

    # And the not-exact state really is reachable and really is distinct from None.
    real_window = state.cases.list_window

    async def _inexact(**kwargs: Any):
        cases, total, _exact = await real_window(**kwargs)
        return cases, total, False

    state.cases.list_window = _inexact  # type: ignore[assignment]
    lower_bound = client.get(
        "/api/cases?from=2026-01-01T00:00:00Z&to=2026-12-31T00:00:00Z"
    ).json()
    state.cases.list_window = real_window  # type: ignore[assignment]

    assert lower_bound["window_total_exact"] is False
    assert lower_bound["window_total_exact"] is not None
    assert {unwindowed["window_total_exact"], windowed["window_total_exact"],
            lower_bound["window_total_exact"]} == {None, True, False}


# =========================================================================== #
# B47 — the shape lint on the sort allowlist
# =========================================================================== #
def test_b47_the_sort_allowlist_contains_only_universal_case_fields(api_client) -> None:
    """B47. Catches: a deployer-specific or nested field entering the allowlist.

    Universal means: a field every ``Case`` carries, declared on the model itself. A
    nested path, a metadata key or a deployer-invented field would be both a
    portability break and, on the ES store, a query-DSL injection point.
    """
    client, _calls, _state = api_client
    universal = set(Case.model_fields)

    for field in _allowlist(client):
        assert field in universal, f"{field} is not a universal Case field"
        assert "." not in field and "*" not in field
        annotation = Case.model_fields[field].annotation
        assert annotation is not None
        # Optional/None-able fields cannot be relied on to order a whole population.
        assert Case.model_fields[field].is_required() or field in universal
