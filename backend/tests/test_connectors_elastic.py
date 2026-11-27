"""Offline tests for the Elasticsearch / OpenSearch pull connectors.

These prove the connectors are faithful wrappers of the existing read-only ES
access: poll/search/fetch_by_ids produce the SAME query bodies (executed against
the in-memory fake) and the SAME KQL rendering as ``app/tools/es_query.py`` and
``app/engine/poller.py``, and ``to_ocsf`` delegates to the ECS→OCSF mapper. Fully
offline (in-memory fake ES, no LLM, no network).
"""

from __future__ import annotations

import pytest

from app.config import Preferences
from app.connectors.base import SearchResult, StructuredQuery
from app.connectors.elastic import ElasticConnector
from app.connectors.opensearch import OpenSearchConnector
from app.constants import (
    OCSF_CAT_IAM,
    OCSF_CLASS_AUTHENTICATION,
    SourceType,
)
from app.es.fake import InMemoryESClient
from app.models import Cursor
from app.utils import now_utc, to_millis
from tests.conftest import make_log_event

pytestmark = pytest.mark.asyncio

INDEX = "all-logs-2026.06.16"


def _seed(es: InMemoryESClient) -> dict[str, int]:
    """Seed a handful of ECS-shaped log docs with stable ids; return base ts."""
    base = to_millis(now_utc()) - 600_000
    docs = [
        ("d1", make_log_event(ip="10.0.0.1", user="alice", host="web01",
                              rule="linux_auth", severity=8.0, ts_millis=base + 1_000)),
        ("d2", make_log_event(ip="10.0.0.1", user="alice", host="web01",
                              rule="linux_auth", severity=8.0, ts_millis=base + 2_000)),
        ("d3", make_log_event(ip="10.0.0.2", user="bob", host="db01",
                              rule="linux_auth", severity=3.0, ts_millis=base + 3_000)),
        ("d4", make_log_event(ip="10.0.0.3", user="carol", host="app01",
                              rule="firewall", severity=9.0, ts_millis=base + 4_000)),
    ]
    for did, src in docs:
        es.add_log(INDEX, src, doc_id=did)
    return {"base": base}


def _prefs() -> Preferences:
    # _env_file is irrelevant for Preferences; defaults match the connector manifest.
    return Preferences(setup_complete=True)


async def test_poll_returns_events_at_or_after_from_millis():
    es = InMemoryESClient()
    ts = _seed(es)["base"]
    conn = ElasticConnector(es)

    # Cursor unset -> uses the cold_start lower bound (from_millis). Ask for events
    # at/after d3's time: d1 and d2 (older) must be excluded, d3 and d4 included.
    from_millis = ts + 3_000
    events = await conn.poll(_prefs(), Cursor(), from_millis)
    ids = {e.id for e in events}
    assert ids == {"d3", "d4"}
    # poll_query sorts ascending (oldest first) — preserve that contract.
    assert [e.id for e in events] == ["d3", "d4"]
    # All returned events are at/after the inclusive lower bound.
    assert all(e.timestamp_millis >= from_millis for e in events)


async def test_poll_honours_cursor_lower_bound():
    es = InMemoryESClient()
    ts = _seed(es)["base"]
    conn = ElasticConnector(es)
    cursor = Cursor(timestamp_millis=ts + 2_000)  # inclusive: includes d2
    events = await conn.poll(_prefs(), cursor, 0)
    assert {e.id for e in events} == {"d2", "d3", "d4"}


async def test_search_filters_by_ip_user_severity_and_renders_kql():
    es = InMemoryESClient()
    _seed(es)
    conn = ElasticConnector(es)
    prefs = _prefs()

    res = await conn.search(
        prefs, StructuredQuery(ip="10.0.0.1", user="alice", severity_gte=5.0)
    )
    assert isinstance(res, SearchResult)
    assert {e.id for e in res.events} == {"d1", "d2"}
    assert res.total == 2
    # KQL rendering parity with es_query.py (term filters then severity range).
    assert res.rendering is not None
    assert res.rendering.query == (
        'source.ip : "10.0.0.1" and user.name : "alice" and event.severity >= 5.0'
    )
    assert res.rendering.language == "kuery"
    assert res.rendering.data_view == prefs.data_view_pattern
    # Default ad-hoc time window matches the legacy tool's defaults.
    assert res.rendering.time_from == "now-24h"
    assert res.rendering.time_to == "now"
    # search sorts newest-first by default.
    assert [e.id for e in res.events] == ["d2", "d1"]


async def test_search_empty_filters_render_star():
    es = InMemoryESClient()
    _seed(es)
    conn = ElasticConnector(es)
    res = await conn.search(_prefs(), StructuredQuery())
    assert res.rendering is not None
    assert res.rendering.query == "*"
    # Everything within the default 24h window is returned.
    assert res.total == 4


async def test_search_contains_multi_match():
    es = InMemoryESClient()
    _seed(es)
    conn = ElasticConnector(es)
    # "carol" appears in d4's message only.
    res = await conn.search(_prefs(), StructuredQuery(contains="carol"))
    assert {e.id for e in res.events} == {"d4"}
    # The rendering names EVERY field the multi_match covers. It used to claim
    # ``message : "*carol*"`` while four fields were searched, so an operator's
    # Discover deep-link ran a narrower query than the agent did. It is also the
    # audited ``query_text``, so the audit trail now records what actually ran.
    fields = _prefs().free_text_search_fields()
    expected = " or ".join(f'{f} : "carol"' for f in fields)
    assert res.rendering.query == f"({expected})"
    # The four legacy fields stay first, in their original order, so an existing
    # deployment's result set only ever grows.
    assert fields[:4] == ["rule.name", "message", "event.original", "event.action"]
    # ...and the connector reports which fields it searched, so a zero-hit result can
    # never be read back as evidence that the data is absent from the record.
    assert res.rendering.fields_searched == fields


async def test_search_contains_matches_a_widened_evidence_field():
    """The regression the whole shared definition exists for.

    A field the model is SHOWN must be a field the model can then SEARCH for.
    ``url.path`` used to be in neither list, so an agent that suspected a missing
    URL got zero hits from fields that could not have matched it, and recorded that
    zero as evidence no HTTP context existed.
    """
    es = InMemoryESClient()
    base = _seed(es)["base"]
    doc = make_log_event(ip="203.0.113.99", user="www-data", host="moodle01",
                         rule="moodle", severity=7.0, ts_millis=base + 5_000)
    # The decision-relevant fields the alert carries but no allowlist ever named.
    doc["url"] = {"path": "/mod/assign/feedback/editpdf/ajax.php"}
    doc["http"] = {"request": {"method": "GET"}}
    es.add_log(INDEX, doc, doc_id="web1")
    conn = ElasticConnector(es)
    res = await conn.search(_prefs(), StructuredQuery(contains="editpdf"))
    assert {e.id for e in res.events} == {"web1"}
    assert "url.path" in res.rendering.fields_searched


async def test_fetch_by_ids_returns_right_docs_and_kql():
    es = InMemoryESClient()
    _seed(es)
    conn = ElasticConnector(es)
    res = await conn.fetch_by_ids(_prefs(), ["d2", "d4"], size=50)
    assert {e.id for e in res.events} == {"d2", "d4"}
    assert res.total == 2
    assert res.rendering is not None
    assert res.rendering.query == '_id in ("d2", "d4")'
    # ids search carries no time bounds (parity with es_query.py).
    assert res.rendering.time_from is None
    assert res.rendering.time_to is None


async def test_search_ids_short_circuits_to_fetch_by_ids():
    es = InMemoryESClient()
    _seed(es)
    conn = ElasticConnector(es)
    res = await conn.search(_prefs(), StructuredQuery(ids=["d1"]))
    assert {e.id for e in res.events} == {"d1"}
    assert res.rendering.query == '_id in ("d1")'


async def test_to_ocsf_yields_ocsf_event_with_entities_and_class():
    es = InMemoryESClient()
    _seed(es)
    conn = ElasticConnector(es)
    prefs = _prefs()
    res = await conn.fetch_by_ids(prefs, ["d1"], size=1)
    hit = res.raw["hits"]["hits"][0]
    ev = conn.to_ocsf(hit, prefs)

    # Authentication finding (event.action == "login").
    assert ev.category_uid == OCSF_CAT_IAM
    assert ev.class_uid == OCSF_CLASS_AUTHENTICATION
    # Entities mapped from the configured fields.
    assert ev.ip == "10.0.0.1"
    assert ev.user == "alice"
    assert ev.host == "web01"
    # Provenance stamped by this connector.
    assert ev.metadata.source_type == SourceType.ELASTICSEARCH.value
    assert ev.metadata.connector == conn.connector_id
    assert ev.metadata.uid == "d1"
    # Observables carry the typed indicators.
    obs = {(o.type, o.value) for o in ev.observables}
    assert ("IP Address", "10.0.0.1") in obs
    assert ("User", "alice") in obs


async def test_manifest_exposes_expected_fields():
    m = ElasticConnector.manifest()
    assert m.source_type == SourceType.ELASTICSEARCH
    assert m.display_name == "Elasticsearch / ELK"
    assert m.query_language == "kuery"
    assert set(m.capabilities) >= {"poll", "search", "fetch_by_ids", "test"}

    auth_keys = {f.key for f in m.auth_fields}
    assert auth_keys == {"es_url", "es_api_key", "es_ca_cert", "es_verify_certs"}
    # The API key is a flagged secret (never echoed).
    api_key = next(f for f in m.auth_fields if f.key == "es_api_key")
    assert api_key.secret is True and api_key.type == "password"

    config_keys = {f.key for f in m.config_fields}
    assert config_keys == {
        "data_view_pattern", "time_field", "source_ip_field", "user_field",
        "host_field", "rule_field", "rule_name_field", "severity_field",
    }
    # Defaults line up with Preferences defaults (so a stock ELK needs no edits).
    by_key = {f.key: f for f in m.config_fields}
    assert by_key["data_view_pattern"].default == "all-logs-*"
    assert by_key["time_field"].default == "@timestamp"
    assert by_key["severity_field"].default == "event.severity"


async def test_ping_and_test_connection():
    es = InMemoryESClient()
    _seed(es)
    conn = ElasticConnector(es)
    assert await conn.ping() is True
    test = await conn.test_connection(_prefs())
    assert test.ok is True
    assert test.sample_count is not None


async def test_opensearch_is_distinct_source_type_and_polls():
    es = InMemoryESClient()
    ts = _seed(es)["base"]
    conn = OpenSearchConnector(es)
    assert conn.source_type == SourceType.OPENSEARCH

    m = OpenSearchConnector.manifest()
    assert m.source_type == SourceType.OPENSEARCH
    assert m.display_name == "OpenSearch"
    assert m.query_language == "lucene"
    assert {f.key for f in m.auth_fields} >= {"es_verify_certs"}

    # Behaviour is inherited: polling works identically.
    events = await conn.poll(_prefs(), Cursor(), ts + 3_000)
    assert {e.id for e in events} == {"d3", "d4"}

    # OCSF provenance reflects the OpenSearch source_type.
    res = await conn.fetch_by_ids(_prefs(), ["d4"], size=1)
    ev = conn.to_ocsf(res.raw["hits"]["hits"][0], _prefs())
    assert ev.metadata.source_type == SourceType.OPENSEARCH.value


# --------------------------------------------------------------------------- #
# audit #6 — non-PIT offset drain must not stall a busy feed.
# --------------------------------------------------------------------------- #
class _NoPitES:
    """A minimal ES with no PIT support (forces the offset fallback). ``search_logs``
    rejects a from+size past the 10k result window (as ES/OpenSearch really do)."""

    def __init__(self, *, raise_at_page: int | None = None) -> None:
        self.froms: list[int] = []
        self._raise_at_page = raise_at_page

    async def search_logs(self, index, body):  # noqa: ANN001
        frm = int(body.get("from", 0))
        size = int(body.get("size", 1))
        self.froms.append(frm)
        if self._raise_at_page is not None and len(self.froms) > self._raise_at_page:
            raise RuntimeError("transient shard failure")
        if frm + size > 10_000:
            raise RuntimeError("Result window is too large, from + size must be <= [10000]")
        return {"hits": {"hits": [
            {"_index": index, "_id": f"{frm}-{j}",
             "_source": {"@timestamp": "2026-06-16T00:00:00Z"}}
            for j in range(size)
        ]}}


async def test_offset_fallback_caps_at_result_window_without_stalling():
    conn = ElasticConnector(_NoPitES())
    es = conn._es
    base_body = {"size": 1500, "query": {"match_all": {}}}
    hits, truncated = await conn._drain_pages(
        "idx", base_body, time_field="@timestamp", max_pages=64,
    )
    # Truncated (more remains) but NO exception escaped — the feed makes progress.
    assert truncated is True
    # It never issued a search that would cross the result window.
    assert es.froms and all(frm + 1500 <= 10_000 for frm in es.froms)
    assert len(hits) > 0  # partial page set returned for the caller to advance the cursor


async def test_offset_fallback_truncates_on_page_error():
    conn = ElasticConnector(_NoPitES(raise_at_page=2))
    es = conn._es
    base_body = {"size": 100, "query": {"match_all": {}}}
    hits, truncated = await conn._drain_pages(
        "idx", base_body, time_field="@timestamp", max_pages=64,
    )
    assert truncated is True
    assert len(es.froms) == 3  # two good pages + the one that raised → stop
    assert len(hits) == 200  # the two good pages were kept, not lost
