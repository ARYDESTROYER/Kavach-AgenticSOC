"""Round 16 CDX2 (PR #144 review, Codex P2): a case's own events behind copies of its id.

An Elasticsearch ``_id`` is unique only within one index, and a data view pattern spans
many indices. ``GET /api/cases/{case_id}/events`` used to read a page's members by their
bare ids over the whole pattern with a size of twice the page, then keep only the
index-qualified members. When the same ``_id`` sat in three or more indices, unrelated
copies filled the size before the member's own index answered, so a one-member case
whose event sat in the third matching index read ``aged_out`` although its event still
existed.

The Elasticsearch connector family (OpenSearch and Wazuh inherit it) now reads a
qualified member by its index and id together (``fetch_by_keys``). The route uses that
optional capability when the source has it; a bare legacy member, and any source
without it, still reads through ``fetch_by_ids``. Every read stays on the read-only log
client over the source's own data view (#1).
"""

from __future__ import annotations

import fnmatch
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.api import routes_case_events as rce
from app.config import Preferences
from app.connectors.base import SearchResult
from app.connectors.elastic import ElasticConnector
from app.connectors.opensearch import OpenSearchConnector
from app.connectors.wazuh import WazuhConnector
from app.es.fake import InMemoryESClient
from app.models import CASE_EVENTS_MAX_LIMIT, RawEvent, make_cursor_event_key
from tests.conftest import make_log_event
from tests.test_round16_wp13_case_records import INDEX, _app, _case, _es, _save, _state

#: Indices of the same data view that sort, and are searched, before the member's own.
EARLIER = ("all-logs-2026.06.14", "all-logs-2026.06.15")
LATER = "all-logs-2026.06.17"


@pytest.fixture(autouse=True)
def _fresh_view_rows():
    rce.RECORDER.reset()
    yield
    rce.RECORDER.reset()


@pytest.fixture
def client():
    with TestClient(_app()) as c:
        yield c


def _seed(c: TestClient, doc_id: str, index: str, **fields: Any) -> str:
    _es(c).add_log(index, make_log_event(ip="203.0.113.9", **fields), doc_id=doc_id)
    return make_cursor_event_key(index, doc_id)


# --------------------------------------------------------------------------- #
# The route, over the real connector and the in-memory cluster
# --------------------------------------------------------------------------- #
def test_a_member_in_the_third_index_with_the_same_id_is_found(client) -> None:
    # The finding: two unrelated copies of the id come back first and fill the read.
    for index in EARLIER:
        _seed(client, "ev-a", index, rule="unrelated_rule")
    member = _seed(client, "ev-a", INDEX, rule="ssh_fail")
    _save(client, _case(member_event_ids=["ev-a"], member_event_keys=[member]))

    page = client.get("/api/cases/case-ev-1/events").json()
    assert page["available"] is True and page["reason"] is None
    assert (page["expected"], page["returned"], page["truncated"]) == (1, 1, False)
    assert page["next_cursor"] is None
    assert [(r["id"], r["index"], r["rule"]) for r in page["rows"]] == [("ev-a", INDEX, "ssh_fail")]


def test_many_copies_never_crowd_out_any_member_of_a_page(client) -> None:
    keys = []
    for i in range(3):
        for index in (*EARLIER, LATER):
            _seed(client, f"ev-{i}", index, rule="unrelated_rule")
        keys.append(_seed(client, f"ev-{i}", INDEX, rule="ssh_fail"))
    _save(client, _case(member_event_ids=[f"ev-{i}" for i in range(3)], member_event_keys=keys))

    first = client.get("/api/cases/case-ev-1/events", params={"limit": 2}).json()
    assert [(r["id"], r["index"]) for r in first["rows"]] == [("ev-0", INDEX), ("ev-1", INDEX)]
    assert first["truncated"] is True and first["next_cursor"] == "2"
    second = client.get("/api/cases/case-ev-1/events",
                        params={"limit": 2, "cursor": first["next_cursor"]}).json()
    assert [(r["id"], r["index"]) for r in second["rows"]] == [("ev-2", INDEX)]
    assert all(r["rule"] == "ssh_fail" for r in first["rows"] + second["rows"])


def test_a_member_whose_event_is_gone_still_reads_aged_out(client) -> None:
    # Copies of the id in other indices are not the member: the page stays honest.
    for index in (*EARLIER, LATER):
        _seed(client, "ev-gone", index, rule="unrelated_rule")
    _save(client, _case(member_event_ids=["ev-gone"],
                        member_event_keys=[make_cursor_event_key(INDEX, "ev-gone")]))
    page = client.get("/api/cases/case-ev-1/events").json()
    assert (page["available"], page["reason"], page["returned"], page["rows"]) == (False, "aged_out", 0, [])


def test_the_keyed_read_stays_on_the_read_only_log_client_and_its_data_view(client, monkeypatch) -> None:
    for index in EARLIER:
        _seed(client, "ev-ro", index)
    member = _seed(client, "ev-ro", INDEX)
    _save(client, _case(member_event_ids=["ev-ro"], member_event_keys=[member]))
    es = _es(client)
    calls: list[str] = []
    real = es.search_logs

    async def _spy(index, body):  # noqa: ANN001
        calls.append(index)
        return await real(index, body)

    monkeypatch.setattr(es, "search_logs", _spy)
    assert client.get("/api/cases/case-ev-1/events").json()["returned"] == 1
    data_view = _state(client).execution_prefs.data_view_pattern
    assert calls == [data_view]


def test_a_member_key_naming_an_index_outside_the_data_view_reads_nothing(client, monkeypatch) -> None:
    # The keyed read narrows the source's data view and never widens it (#1): an event
    # with the member's id, in an index the data view does not cover, stays unread.
    outside = "tenant-b-2026.06.16"
    _es(client).add_log(outside, make_log_event(ip="203.0.113.9", rule="other_tenant"), doc_id="ev-out")
    _save(client, _case(member_event_ids=["ev-out"],
                        member_event_keys=[make_cursor_event_key(outside, "ev-out")]))
    es = _es(client)
    calls: list[str] = []
    real = es.search_logs

    async def _spy(index, body):  # noqa: ANN001
        calls.append(index)
        return await real(index, body)

    monkeypatch.setattr(es, "search_logs", _spy)
    page = client.get("/api/cases/case-ev-1/events").json()
    assert (page["available"], page["reason"], page["rows"]) == (False, "aged_out", [])
    data_view = _state(client).execution_prefs.data_view_pattern
    assert calls == [data_view]
    assert not any(fnmatch.fnmatch(outside, part.strip()) for part in data_view.split(","))


def test_a_mixed_page_reads_qualified_members_by_key_and_bare_ones_by_id(client) -> None:
    for index in EARLIER:
        _seed(client, "ev-q", index, rule="unrelated_rule")
    qualified = _seed(client, "ev-q", INDEX, rule="ssh_fail")
    _seed(client, "ev-bare", INDEX, rule="ssh_ok")
    _save(client, _case(member_event_ids=["ev-q", "ev-bare"], member_event_keys=[qualified, "ev-bare"]))
    page = client.get("/api/cases/case-ev-1/events").json()
    assert page["available"] is True
    assert [(r["id"], r["index"], r["rule"]) for r in page["rows"]] == [
        ("ev-q", INDEX, "ssh_fail"), ("ev-bare", INDEX, "ssh_ok"),
    ]


# --------------------------------------------------------------------------- #
# The route's choice of read, with stand-in sources
# --------------------------------------------------------------------------- #
def _event(event_id: str, index: str, rule: str = "r") -> RawEvent:
    return RawEvent(id=event_id, index=index, source={"rule": {"name": rule}}, rule=rule)


class _ByIdOnly:
    """A source with no keyed read: an ES-like ids read, foreign copies first."""

    def __init__(self, held: list[RawEvent]) -> None:
        self.held = held
        self.calls: list[tuple[list[str], int]] = []

    async def fetch_by_ids(self, prefs, ids, size):  # noqa: ANN001
        self.calls.append((list(ids), size))
        events = [ev for ev in self.held if ev.id in set(ids)][:size]
        return SearchResult(events=events, total=len(events))


class _Keyed(_ByIdOnly):
    """A source with the keyed read."""

    def __init__(self, held: list[RawEvent]) -> None:
        super().__init__(held)
        self.keyed: list[tuple[list[str], int]] = []

    async def fetch_by_keys(self, prefs, keys, size):  # noqa: ANN001
        self.keyed.append((list(keys), size))
        wanted = set(keys)
        events = [ev for ev in self.held if ev.event_key() in wanted][:size]
        return SearchResult(events=events, total=len(events))


def test_the_route_reads_qualified_members_through_the_keyed_capability(client, monkeypatch) -> None:
    held = [_event("ev-a", EARLIER[0], "unrelated"), _event("ev-a", EARLIER[1], "unrelated"),
            _event("ev-a", INDEX, "ssh_fail")]
    source = _Keyed(held)
    monkeypatch.setattr(_state(client), "active_source_for_id", lambda source_id: source)
    member = make_cursor_event_key(INDEX, "ev-a")
    _save(client, _case(member_event_ids=["ev-a"], member_event_keys=[member]))

    page = client.get("/api/cases/case-ev-1/events").json()
    assert page["available"] is True and [r["rule"] for r in page["rows"]] == ["ssh_fail"]
    assert source.keyed == [([member], 2)] and source.calls == []


def test_the_keyed_read_size_keeps_the_old_bound(client, monkeypatch) -> None:
    source = _Keyed([])
    monkeypatch.setattr(_state(client), "active_source_for_id", lambda source_id: source)
    keys = [make_cursor_event_key(INDEX, f"ev-{i}") for i in range(CASE_EVENTS_MAX_LIMIT)]
    _save(client, _case(member_event_ids=[f"ev-{i}" for i in range(CASE_EVENTS_MAX_LIMIT)],
                        member_event_keys=keys))
    page = client.get("/api/cases/case-ev-1/events", params={"limit": CASE_EVENTS_MAX_LIMIT}).json()
    assert page["reason"] == "aged_out"
    assert source.keyed == [(keys, 2 * CASE_EVENTS_MAX_LIMIT)]


def test_a_bare_legacy_member_reads_by_id_on_a_keyed_source(client, monkeypatch) -> None:
    source = _Keyed([_event("ev-legacy", INDEX)])
    monkeypatch.setattr(_state(client), "active_source_for_id", lambda source_id: source)
    _save(client, _case(member_event_ids=["ev-legacy"], member_event_keys=[]))
    page = client.get("/api/cases/case-ev-1/events").json()
    assert page["available"] is True and [r["id"] for r in page["rows"]] == ["ev-legacy"]
    assert source.keyed == [] and source.calls == [(["ev-legacy"], 2)]


def test_a_source_without_the_keyed_read_keeps_the_ids_read(client, monkeypatch) -> None:
    source = _ByIdOnly([_event("ev-a", INDEX, "ssh_fail")])
    monkeypatch.setattr(_state(client), "active_source_for_id", lambda source_id: source)
    member = make_cursor_event_key(INDEX, "ev-a")
    _save(client, _case(member_event_ids=["ev-a"], member_event_keys=[member]))
    page = client.get("/api/cases/case-ev-1/events").json()
    assert page["available"] is True and [r["rule"] for r in page["rows"]] == ["ssh_fail"]
    assert source.calls == [(["ev-a"], 2)]


def test_a_failing_or_slow_keyed_read_is_source_unavailable(client, monkeypatch) -> None:
    class _Broken(_Keyed):
        async def fetch_by_keys(self, prefs, keys, size):  # noqa: ANN001
            raise RuntimeError("connection refused")

    monkeypatch.setattr(_state(client), "active_source_for_id", lambda source_id: _Broken([]))
    _save(client, _case(member_event_ids=["ev-a"], member_event_keys=[make_cursor_event_key(INDEX, "ev-a")]))
    page = client.get("/api/cases/case-ev-1/events").json()
    assert (page["available"], page["reason"]) == (False, "source_unavailable")

    class _Slow(_Keyed):
        async def fetch_by_keys(self, prefs, keys, size):  # noqa: ANN001
            import asyncio

            await asyncio.sleep(5)
            return SearchResult()

    monkeypatch.setattr(rce, "READ_TIMEOUT_S", 0.05)
    monkeypatch.setattr(_state(client), "active_source_for_id", lambda source_id: _Slow([]))
    page = client.get("/api/cases/case-ev-1/events").json()
    assert (page["available"], page["reason"]) == (False, "source_unavailable")


# --------------------------------------------------------------------------- #
# The connector capability
# --------------------------------------------------------------------------- #
def _cluster() -> InMemoryESClient:
    es = InMemoryESClient()
    for index in (*EARLIER, INDEX, LATER):
        es.add_log(index, make_log_event(ip="10.0.0.1", rule=f"rule-{index}"), doc_id="d1")
    es.add_log(INDEX, make_log_event(ip="10.0.0.2", rule="other"), doc_id="d2")
    return es


@pytest.mark.asyncio
@pytest.mark.parametrize("cls", [ElasticConnector, OpenSearchConnector, WazuhConnector])
async def test_fetch_by_keys_answers_each_key_from_its_own_index_only(cls) -> None:
    conn = cls(_cluster())
    keys = [make_cursor_event_key(INDEX, "d1"), make_cursor_event_key(LATER, "d1")]
    res = await conn.fetch_by_keys(Preferences(setup_complete=True), keys, size=len(keys))
    assert sorted(ev.event_key() for ev in res.events) == sorted(keys)
    assert res.total == 2
    assert res.rendering is not None and res.rendering.time_from is None and res.rendering.time_to is None


@pytest.mark.asyncio
async def test_fetch_by_keys_reads_a_bare_key_by_its_id() -> None:
    conn = ElasticConnector(_cluster())
    res = await conn.fetch_by_keys(Preferences(setup_complete=True), ["d2"], size=5)
    assert [(ev.id, ev.index) for ev in res.events] == [("d2", INDEX)]


@pytest.mark.asyncio
async def test_fetch_by_keys_body_and_rendering() -> None:
    es = _cluster()
    seen: list[tuple[str, dict[str, Any]]] = []
    real = es.search_logs

    async def _spy(index, body):  # noqa: ANN001
        seen.append((index, body))
        return await real(index, body)

    es.search_logs = _spy  # type: ignore[method-assign]
    conn = ElasticConnector(es)
    keys = [make_cursor_event_key(INDEX, "d1"), make_cursor_event_key(INDEX, "d2"), "d9"]
    res = await conn.fetch_by_keys(Preferences(setup_complete=True), keys, size=6)
    assert len(seen) == 1
    index, body = seen[0]
    assert index == Preferences(setup_complete=True).data_view_pattern
    assert body["size"] == 6
    assert body["query"] == {"bool": {"minimum_should_match": 1, "should": [
        {"bool": {"filter": [{"term": {"_index": INDEX}}, {"ids": {"values": ["d1", "d2"]}}]}},
        {"ids": {"values": ["d9"]}},
    ]}}
    assert res.rendering.query == f'(_index : "{INDEX}" and _id in ("d1", "d2")) or _id in ("d9")'


@pytest.mark.asyncio
async def test_fetch_by_keys_with_no_keys_asks_nothing() -> None:
    es = _cluster()
    calls: list[str] = []
    real = es.search_logs

    async def _spy(index, body):  # noqa: ANN001
        calls.append(index)
        return await real(index, body)

    es.search_logs = _spy  # type: ignore[method-assign]
    res = await ElasticConnector(es).fetch_by_keys(Preferences(setup_complete=True), [], size=4)
    assert res.events == [] and res.total == 0 and calls == []
