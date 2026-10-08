"""``PullConnector.aggregate`` (Elastic / OpenSearch / Wazuh) and ``log_stats``'s
exact-vs-sample paths (chat revamp SPEC §5.3)."""

from __future__ import annotations

import copy
from typing import Any

from app.agents.chat_tools.logs import LogStatsTool
from app.config import Preferences
from app.connectors.base import PullConnector, StructuredQuery, aggregate_field
from app.connectors.elastic import ElasticConnector
from app.connectors.opensearch import OpenSearchConnector
from app.connectors.wazuh import WazuhConnector
from app.es.fake import InMemoryESClient
from app.utils import now_utc, to_millis

from tests.conftest import make_log_event
from tests.test_chat_tools_support import assert_artifacts_render, make_ctx


def _seed(es: InMemoryESClient, n: int = 30, index: str = "all-logs-2026") -> None:
    now = to_millis(now_utc())
    for i in range(n):
        es.add_log(index, make_log_event(
            ip=f"203.0.113.{i % 4}", user="alice" if i % 3 else "bob", host=f"web{i % 2}",
            rule="linux_auth" if i % 5 else "sshd", ts_millis=now - i * 60_000,
        ))


class RecordingES(InMemoryESClient):
    """Fake ES that records every log search body and can fail on demand.

    ``keyword_fields`` lists the fields that have a ``.keyword`` sub-field, as text
    fields do under the default dynamic mapping; a ``terms`` aggregation on any
    other ``<field>.keyword`` finds nothing, exactly like a real cluster."""

    def __init__(self, fail_first_with: int | None = None, always_fail: bool = False,
                 error_text: str = "bad request: fielddata disabled",
                 keyword_fields: tuple[str, ...] = ("user.name", "host.name", "source.ip", "rule.id")) -> None:
        super().__init__()
        self.bodies: list[dict[str, Any]] = []
        self._fail_first_with = fail_first_with
        self._always_fail = always_fail
        self._error_text = error_text
        self._keyword_fields = keyword_fields

    async def search_logs(self, index: str, body: dict[str, Any]) -> dict[str, Any]:
        self.bodies.append(copy.deepcopy(body))
        if self._always_fail:
            raise RuntimeError("cluster unreachable")
        if self._fail_first_with is not None and len(self.bodies) == 1:
            exc = RuntimeError(self._error_text)
            exc.status_code = self._fail_first_with  # type: ignore[attr-defined]
            raise exc
        body = copy.deepcopy(body)
        for agg in (body.get("aggs") or {}).values():
            for kind in ("terms", "cardinality"):
                spec = agg.get(kind)
                if spec and str(spec.get("field", "")).endswith(".keyword"):
                    base = spec["field"][: -len(".keyword")]
                    spec["field"] = base if base in self._keyword_fields else "no.such.field"
        return await super().search_logs(index, body)


async def test_elastic_aggregate_is_exact_on_fake_es() -> None:
    es = InMemoryESClient()
    _seed(es, 30)
    result = await ElasticConnector(es).aggregate(
        Preferences(), StructuredQuery(time_from="now-2h"), ["ip", "user", "rule"], "15m", 3,
    )
    assert result is not None and result.total == 30
    assert [b.count for b in result.groups["ip"]] == [8, 8, 7]
    assert result.other["ip"] == 7  # the fourth IP, outside the top 3
    assert result.distinct == {"ip": 4, "user": 2, "rule": 2}
    assert sum(b.count for b in result.over_time) == 30
    assert all(b.key.endswith("+00:00") for b in result.over_time)
    assert result.rendering is not None and result.rendering.language == "kuery"


async def test_aggregate_filters_match_search_filters() -> None:
    """The exact count and a search describe ONE population: same filter clauses."""
    es = RecordingES()
    _seed(es, 5)
    conn = ElasticConnector(es)
    sq = StructuredQuery(ip="203.0.113.1", user="alice", rule="sshd", severity_gte=3,
                         contains="login", time_from="now-1h", time_to="now")
    await conn.search(Preferences(), sq)
    await conn.aggregate(Preferences(), sq, ["host"], "5m", 5)
    search_filters, agg_filters = (b["query"]["bool"]["filter"] for b in es.bodies)
    # Time bounds are resolved per call (milliseconds apart); compare the rest exactly.
    assert search_filters[:-1] == agg_filters[:-1]
    assert list(search_filters[-1]["range"]) == list(agg_filters[-1]["range"])
    assert es.bodies[1]["size"] == 0 and es.bodies[1]["track_total_hits"] is True


async def test_aggregate_retries_once_with_keyword_on_400() -> None:
    es = RecordingES(fail_first_with=400)
    _seed(es, 6)
    result = await ElasticConnector(es).aggregate(Preferences(), StructuredQuery(), ["user", "severity"], None, 5)
    assert result is not None and len(es.bodies) == 2
    retried = es.bodies[1]["aggs"]
    assert retried["g_user"]["terms"]["field"] == "user.name.keyword"
    assert retried["g_severity"]["terms"]["field"] == "event.severity"  # numeric: no suffix


async def test_aggregate_retries_only_the_field_the_error_names() -> None:
    """Mixed mappings: only the text field that caused the 400 gets ``.keyword``;
    an already exact-valued field keeps its name (it has no such sub-field)."""
    es = RecordingES(fail_first_with=400, error_text=(
        "search_phase_execution_exception: Text fields are not optimised ... set fielddata=true "
        "on [user.name] in order to load field data"))
    _seed(es, 6)
    result = await ElasticConnector(es).aggregate(Preferences(), StructuredQuery(), ["user", "ip"], None, 5)
    assert result is not None and len(es.bodies) == 2
    retried = es.bodies[1]["aggs"]
    assert retried["g_user"]["terms"]["field"] == "user.name.keyword"
    assert retried["g_ip"]["terms"]["field"] == "source.ip"
    assert result.groups["ip"] and result.groups["user"]


async def test_a_keyword_guess_that_finds_nothing_falls_back_to_sampling() -> None:
    """An unnamed 400 retries every string field; a field with no ``.keyword``
    sub-field then comes back empty, which must not be published as an exact empty
    group (G3): the connector returns None and log_stats samples instead."""
    es = RecordingES(fail_first_with=400, keyword_fields=("user.name",))
    _seed(es, 6)
    conn = ElasticConnector(es)
    assert await conn.aggregate(Preferences(), StructuredQuery(), ["user", "host"], None, 5) is None
    assert len(es.bodies) == 2
    sampled_es = RecordingES(fail_first_with=400, keyword_fields=("user.name",))
    _seed(sampled_es, 6)
    out = await LogStatsTool().run(make_ctx(log_source=ElasticConnector(sampled_es)), group_by=["host"])
    # aggregate (400), the .keyword retry (empty group), then the sample search.
    assert out.ok and len(sampled_es.bodies) == 3 and sampled_es.bodies[2]["size"] == 200
    assert {row["value"] for row in out.observation["top"]["host"]} == {"web0", "web1"}


async def test_aggregate_failure_or_id_lookup_returns_none() -> None:
    failing = ElasticConnector(RecordingES(always_fail=True))
    assert await failing.aggregate(Preferences(), StructuredQuery(), ["ip"], "1h", 5) is None
    es = RecordingES()
    assert await ElasticConnector(es).aggregate(Preferences(), StructuredQuery(ids=["x"]), ["ip"]) is None
    assert es.bodies == []


async def test_opensearch_and_wazuh_inherit_aggregate_with_their_field_mapping() -> None:
    es = InMemoryESClient()
    now = to_millis(now_utc())
    for i in range(4):
        es.add_log("wazuh-alerts-4.x-2026", {
            "timestamp": now - i * 1000, "data": {"srcip": "198.51.100.9" if i else "198.51.100.10"},
            "agent": {"name": "agent-1"}, "rule": {"id": "5710", "level": 10, "description": "ssh"},
        })
    cfg = {"data_view_pattern": "wazuh-alerts-*", "time_field": "timestamp", "source_ip_field": "data.srcip",
           "host_field": "agent.name", "rule_field": "rule.id", "severity_field": "rule.level"}
    wazuh = WazuhConnector(es, config=cfg, connector_id="wz")
    result = await wazuh.aggregate(Preferences(), StructuredQuery(time_from="now-1h"), ["ip", "host"], "1h", 5)
    assert result is not None and result.total == 4
    assert result.groups["ip"][0].key == "198.51.100.9" and result.groups["ip"][0].count == 3
    assert aggregate_field(wazuh._effective_prefs(Preferences()), "ip") == "data.srcip"
    assert OpenSearchConnector.aggregate is ElasticConnector.aggregate


async def test_base_connector_default_aggregate_is_none() -> None:
    class Plain(PullConnector):
        source_type = ElasticConnector.source_type

        @classmethod
        def manifest(cls):  # pragma: no cover - not used
            return ElasticConnector.manifest()

        async def ping(self):  # pragma: no cover
            return True

        async def poll(self, prefs, cursor, from_millis):  # pragma: no cover
            return []

        async def search(self, prefs, query):  # pragma: no cover
            raise AssertionError

        async def fetch_by_ids(self, prefs, ids, size):  # pragma: no cover
            raise AssertionError

    assert await Plain().aggregate(Preferences(), StructuredQuery(), ["ip"]) is None


class SampleOnlyConnector(ElasticConnector):
    """An Elastic connector whose backend cannot aggregate (the sample path)."""

    async def aggregate(self, *args: Any, **kwargs: Any):
        return None


async def test_log_stats_exact_path() -> None:
    es = InMemoryESClient()
    _seed(es, 30)
    ctx = make_ctx(log_source=ElasticConnector(es))
    out = await LogStatsTool().run(ctx, group_by=["ip", "user"], top_n=2, interval="15m", time_from="now-2h")
    assert out.ok and out.basis == "exact"
    assert out.observation["total"] == 30 and out.observation["basis"] == "exact"
    assert out.observation["top"]["ip"][0]["count"] == 8
    cats = [a for a in out.artifacts if a.kind == "categories"]
    assert [a.title for a in cats] == ["Top source IPs", "Top users"]
    assert cats[0].truncated and cats[0].data["other"] == 14
    assert out.coverage is None
    assert_artifacts_render(out)


async def test_log_stats_sample_path_states_coverage() -> None:
    es = InMemoryESClient()
    _seed(es, 250)
    ctx = make_ctx(log_source=SampleOnlyConnector(es))
    out = await LogStatsTool().run(ctx, group_by="ip", time_from="now-6h")
    assert out.ok and out.basis == "newest_n"
    assert out.observation["total"] == 250  # the connector's exact match count
    assert out.coverage == "newest 200 sampled of 250"
    assert all(a.basis == "newest_n" for a in out.artifacts if a.kind == "categories")
    assert_artifacts_render(out)


async def test_log_stats_heatmap_and_invalid_group() -> None:
    es = InMemoryESClient()
    _seed(es, 40)
    ctx = make_ctx(log_source=SampleOnlyConnector(es))
    out = await LogStatsTool().run(ctx, group_by=["host"], include_heatmap=True, time_from="now-2h")
    heat = [a for a in out.artifacts if a.kind == "heatmap"]
    assert heat and heat[0].data["y"] and len(heat[0].data["cells"]) == len(heat[0].data["y"])
    assert_artifacts_render(out)
    bad = await LogStatsTool().run(ctx, group_by=["password"])
    assert not bad.ok and bad.error == "Invalid input: check group_by"


async def test_exact_multi_source_counts_stay_exact_when_top_values_merge() -> None:
    """Totals and the series are exact; only the merged per-source top-N values are
    lower bounds, and only those artifacts say so."""
    from app.engine.log_rows import BrowseTarget

    conns = {}
    for sid in ("a", "b"):
        es = InMemoryESClient()
        _seed(es, 12)
        conns[sid] = ElasticConnector(es)

    async def never_read(sq):  # pragma: no cover - the exact path never samples
        raise AssertionError

    targets = [BrowseTarget(sid, f"Source {sid}", "search", never_read) for sid in conns]
    ctx = make_ctx(browse_sources=lambda: targets, source_resolver=lambda sid: conns[sid])
    out = await LogStatsTool().run(ctx, group_by=["ip"], top_n=2, time_from="now-1h")
    assert out.ok and out.basis == "exact" and out.observation["total"] == 24
    assert out.observation["top_values_are_lower_bounds"] is True
    assert "merged top values are lower bounds" in out.summary
    assert "per-source top values merged" in (out.coverage or "")
    cats = [a for a in out.artifacts if a.kind == "categories"]
    assert cats and all(a.basis == "sample" and a.truncated for a in cats)
    assert all(a.basis == "exact" for a in out.artifacts if a.kind in ("series", "kpis"))
    assert_artifacts_render(out)
