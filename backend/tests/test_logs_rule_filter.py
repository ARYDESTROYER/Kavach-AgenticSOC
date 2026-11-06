"""Round 14 (SPEC §4.6.1, §4.7.2): exact rule and severity filters on existing reads.

What this pins:

* **Named levels.** ``engine.severity_levels`` projects a raw severity through ITS OWN
  source's ceiling before the one ladder (74/48/22/8, the ``priority`` cuts), so a 0 to
  15 and a 0 to 10 source land in the same five levels as a 0 to 100 source; the raw
  range a native filter uses agrees with the projection to the last bit.
* **``GET /api/logs``** gains ``rule``, ``severity`` and ``severity_gte``. Pull sources
  compile them into the connector's own query (exact: the rows, the match total and an
  aggregate describe one population); a push source's live-tail ring is filtered by the
  route over the whole ring, kept to an explicit ``from``/``to`` as the rule summary
  reads it, and reported ``exact: false``; Demo adapters stay exact
  while their answer holds every match. ``filters`` is echoed only while a filter is
  active, so an unfiltered request is answered key for key as before. Bad values are a
  400 and a rule value is matched exactly, never as a substring or query syntax (#9).
* **A rule is any rule identity** of an event: the rule field, the rule name field, or
  the suite rule it is classified as (first enabled catalog match by priority).
* **Exact on any mapping.** Every rule clause matches the exact-value ``.keyword``
  sub-field when a document has one and the field itself only when it does not, so an
  analysed ``text`` field (the default dynamic mapping) never misses a multi-word rule
  or matches a single token inside other names.
* **Counts beyond the page.** While a filter is active each source reports its match
  ``total`` and ``total_relation`` and the envelope ``matched: {count, relation}``, the
  number the rule summary counts for the same rule and window.
* **The composite aggregation** (``ElasticConnector.aggregate_composite``, the exact
  two-level breakdown) pages, counts missing values, stops at its bucket cap and says so,
  and retries an analysed text field on ``.keyword`` once; the level series
  (``aggregate_level_series``) counts named levels natively whatever the raw values.
* **Only what the rows can show is counted.** A filtered read leaves out a source's
  IGNORE carve-outs natively (longest pattern wins, as the union search attributes an
  index), so the match total is the muted population's complement; a carve-out that
  cannot be expressed natively, or muted events reaching a native answer, leave the
  source "at least" with no total. A search answered from part of its data (a failed
  shard, a timeout) is never exact: the total is "at least" and every aggregation
  declines. A push ring holds events already normalised onto the canonical 0 to 100
  score, so its levels are read on the default ceiling, never projected twice.
* **``GET /api/cases``** gains an exact ``rule`` (a value of ``Case.rule_ids`` as stored)
  and ``closed_by`` (``agent``, ``analyst``, ``analyst_policy``, ``system``: the engine's
  values and only those; any other value, ``human`` included, is a 400), both
  answered by the exact queue scan, and the queue search matches rule values. An
  unfinished queue scan releases its read snapshot when it is cancelled.
"""

from __future__ import annotations

import asyncio
import math
import random
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.routes import router
from app.config import Preferences, RuleDefinition, RuleMatch, SourceInstance
from app.connectors.base import SearchResult, StructuredQuery
from app.connectors.elastic import (
    ElasticConnector,
    LogFilterQuery,
    exact_value_clause,
    rule_identity_clause,
    severity_upper_clause,
)
from app.constants import CaseStatus, DecisionBy, EntityType, SourceSurface, SourceType, Verdict
from app.engine import log_rows
from app.engine.log_rows import LogFilter, event_rule_identities, valid_rule_value
from app.engine.priority import _severity_band_from_magnitude
from app.engine.severity_levels import (
    LEVEL_FLOORS,
    LEVELS_DESCENDING,
    SeverityTally,
    level_at_least,
    level_of_raw,
    raw_floor,
    raw_range,
)
from app.es.fake import InMemoryESClient
from app.models import Case, Entity, RawEvent
from app.ocsf.model import project_severity_magnitude
from app.state import AppState
from app.utils import now_utc, to_millis

UTC = timezone.utc
INDEX_A = "wazuh-alerts-2026.10.26"
INDEX_B = "ecs-logs-2026.10.26"
NON_ASCII_RULE = "Fehlgeschlagene Anmeldung über SSH"


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def _run(coro: Any) -> Any:
    """Run a coroutine on a private loop. ``asyncio.run`` would leave the thread with
    no current loop, which breaks a later test that calls ``get_event_loop()``."""
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


def _doc(*, module: str | None = None, name: str | None = None, severity: Any = 5,
         ip: str = "203.0.113.10", host: str = "web01", user: str = "root",
         ts_millis: int | None = None, rule_id: str | None = None) -> dict[str, Any]:
    """An ECS-ish document for the default field mapping (rule field ``event.module``,
    rule name field ``rule.name``, severity ``event.severity``). ``severity=None`` leaves
    the severity field out entirely."""
    ts = ts_millis if ts_millis is not None else to_millis(now_utc()) - 60_000
    event: dict[str, Any] = {"action": "login", "outcome": "failure"}
    if module is not None:
        event["module"] = module
    if severity is not None:
        event["severity"] = severity
    doc: dict[str, Any] = {
        "@timestamp": datetime.fromtimestamp(ts / 1000, tz=UTC).isoformat(),
        "source": {"ip": ip},
        "user": {"name": user},
        "host": {"name": host},
        "event": event,
        "message": f"{module or name} from {ip}",
    }
    rule: dict[str, Any] = {}
    if name is not None:
        rule["name"] = name
    if rule_id is not None:
        rule["id"] = rule_id
    if rule:
        doc["rule"] = rule
    return doc


@pytest.fixture
def client(secrets, mock_provider):
    yield from _client_for(secrets, mock_provider)


@pytest.fixture(params=["elasticsearch", "sqlite"])
def case_client(request, tmp_path, mock_provider):
    """The Cases list on the fake Elasticsearch store and on SQLite."""
    from app.config import Secrets

    extra: dict[str, Any] = {}
    if request.param == "sqlite":
        extra = {"state_backend": "sqlite", "state_db_url": f"sqlite+aiosqlite:///{tmp_path / 'state.db'}"}
    secrets = Secrets(_env_file=None, es_store_enabled=False, redis_url="", anthropic_api_key=None,
                      openai_api_key=None, **extra)
    yield from _client_for(secrets, mock_provider)


def _client_for(secrets, mock_provider):
    overrides = {"anthropic": mock_provider, "openai": mock_provider, "mock": mock_provider}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        es = InMemoryESClient()
        state = AppState.create(secrets=secrets, es=es, provider_overrides=overrides)
        await state.startup(start_poller=False)
        # An empty suite catalog unless a test sets one: the rule a row shows is then
        # its rule field, else its rule name.
        await state.update_prefs(state.prefs.model_copy(update={
            "setup_complete": True, "rule_catalog": [],
        }))
        app.state.tlsoc = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    api.include_router(router)
    with TestClient(api) as c:
        yield c


def _add_source(client: TestClient, sid: str, pattern: str, *, scale: float | None = None,
                source_type: str = "elasticsearch") -> None:
    body: dict[str, Any] = {"id": sid, "source_type": source_type, "config": {"data_view_pattern": pattern}}
    if scale is not None:
        body["severity_scale_max"] = scale
    r = client.post("/api/sources", json=body)
    assert r.status_code == 200, r.text


def _es(client: TestClient) -> InMemoryESClient:
    return client.app.state.tlsoc.es


def _logs(client: TestClient, **params: Any) -> dict[str, Any]:
    r = client.get("/api/logs", params={"limit": 200, **params})
    assert r.status_code == 200, r.text
    return r.json()


# --------------------------------------------------------------------------- #
# 1. Named levels and the per-source projection
# --------------------------------------------------------------------------- #
def test_the_level_floors_are_the_one_ladder() -> None:
    assert LEVELS_DESCENDING == ("critical", "high", "medium", "low", "info")
    assert LEVEL_FLOORS == {"critical": 74.0, "high": 48.0, "medium": 22.0, "low": 8.0, "info": None}
    for tenths in range(0, 1001):
        magnitude = tenths / 10.0
        assert level_of_raw(magnitude, 100) == _severity_band_from_magnitude(magnitude)


@pytest.mark.parametrize(("scale", "raw", "level"), [
    # Wazuh-style 0 to 15: a rule level of 12 is Critical, 8 High, 4 Medium, 2 Low, 1 Info.
    (15, 12, "critical"), (15, 8, "high"), (15, 4, "medium"), (15, 2, "low"), (15, 1, "info"),
    # QRadar-style 0 to 10.
    (10, 8, "critical"), (10, 5, "high"), (10, 3, "medium"), (10, 1, "low"), (10, 0, "info"),
    # The canonical 0 to 100 score.
    (100, 80, "critical"), (100, 50, "high"), (100, 30, "medium"), (100, 10, "low"), (100, 5, "info"),
    # Above the declared ceiling saturates; below zero and missing read as Info.
    (15, 99, "critical"), (100, -4, "info"), (100, None, "info"), (100, "", "info"),
])
def test_a_raw_value_reaches_its_level_through_its_own_scale(scale, raw, level) -> None:
    assert level_of_raw(raw, scale) == level


@pytest.mark.parametrize("scale", [100, 10, 15, 16, 1000, 7, 3.3, 0.5, 255])
def test_the_raw_range_agrees_with_the_projection_to_the_last_bit(scale) -> None:
    """``raw_range`` is what a native filter compiles; ``level_of_raw`` is what a row
    shows. They must never disagree, at the floors or anywhere else."""
    probes: list[float] = []
    for level in LEVELS_DESCENDING:
        floor = raw_floor(level, scale)
        if floor is None:
            continue
        assert project_severity_magnitude(floor, scale) >= LEVEL_FLOORS[level]
        assert project_severity_magnitude(math.nextafter(floor, -math.inf), scale) < LEVEL_FLOORS[level]
        for steps in range(-3, 4):
            value = floor
            for _ in range(abs(steps)):
                value = math.nextafter(value, math.inf if steps > 0 else -math.inf)
            probes.append(value)
    rng = random.Random(14)
    probes += [rng.uniform(-scale, 2 * scale) for _ in range(2000)]
    probes += [x / 100 for x in range(-100, int(scale * 100) + 100, max(1, int(scale)))]
    for level in LEVELS_DESCENDING:
        exact = raw_range(level=level, scale_max=scale)
        at_least = raw_range(at_least=level, scale_max=scale)
        for value in probes:
            shown = level_of_raw(value, scale)
            assert exact.matches(value) is (shown == level), (scale, level, value)
            assert at_least.matches(value) is level_at_least(shown, level), (scale, level, value)


def test_info_includes_a_missing_value_and_contradictions_keep_nothing() -> None:
    info = raw_range(level="info", scale_max=15)
    assert info.gte is None and info.lt == raw_floor("low", 15) and info.include_missing
    assert raw_range(at_least="info").unbounded
    assert not raw_range(at_least="low").include_missing
    empty = raw_range(level="low", at_least="high", scale_max=100)
    assert empty.gte is not None and empty.lt is not None and empty.gte >= empty.lt
    assert not any(empty.matches(v) for v in (0, 9, 30, 50, 80, None))


def test_the_tally_merges_two_scales_level_by_level_with_every_level_present() -> None:
    tally = SeverityTally()
    tally.add(12, scale_max=15, count=3, rule="ssh_fail", source="wazuh", bucket="b1")
    tally.add(80, scale_max=100, count=2, rule="ssh_fail", source="ecs", bucket="b2")
    tally.add(8, scale_max=10, count=1, rule="scan", source="qradar", bucket="b1")
    tally.add(1, scale_max=15, count=4, rule="noise", source="wazuh")
    tally.add(5, count=0, rule="ignored")
    assert [s.level for s in tally.levels()] == list(LEVELS_DESCENDING)
    assert tally.counts() == {"critical": 6, "high": 0, "medium": 0, "low": 0, "info": 4}
    assert tally.total == 10
    critical = tally.level("critical")
    assert critical.top_rules() == [("ssh_fail", 5), ("scan", 1)] and critical.rules_total == 2
    assert critical.raw_values == [
        {"value": 12.0, "scale_max": 15.0}, {"value": 80.0, "scale_max": 100.0},
        {"value": 8.0, "scale_max": 10.0},
    ]
    assert tally.shares() == {"critical": 60.0, "high": 0.0, "medium": 0.0, "low": 0.0, "info": 40.0}
    assert tally.bucket_counts() == {
        "b1": {"critical": 4, "high": 0, "medium": 0, "low": 0, "info": 0},
        "b2": {"critical": 2, "high": 0, "medium": 0, "low": 0, "info": 0},
    }
    assert SeverityTally().shares() == {lv: 0.0 for lv in LEVELS_DESCENDING}


# --------------------------------------------------------------------------- #
# 2. Validation
# --------------------------------------------------------------------------- #
def test_rule_values_are_one_line_and_at_most_256_characters() -> None:
    assert valid_rule_value("ssh_fail")
    assert valid_rule_value(NON_ASCII_RULE)
    assert valid_rule_value("x" * 256)
    assert valid_rule_value(" leading and trailing ")
    for bad in ("", "x" * 257, "a\nb", "a\rb", "a b", "a b", "a​b", "a\x00b", 5, None):
        assert not valid_rule_value(bad), repr(bad)


def test_the_filter_parses_levels_and_refuses_unknown_ones() -> None:
    flt = LogFilter.parse(rule="ssh_fail", severity="High", severity_gte="")
    assert flt == LogFilter(rule="ssh_fail", severity="high", severity_gte=None)
    assert flt.echo() == {"rule": "ssh_fail", "severity": "high", "severity_gte": None}
    assert not LogFilter.parse(rule="", severity=None, severity_gte="  ").active
    with pytest.raises(ValueError, match="severity must be one of info, low, medium, high, critical"):
        LogFilter.parse(severity="severe")
    with pytest.raises(ValueError, match="severity_gte"):
        LogFilter.parse(severity_gte="7")
    with pytest.raises(ValueError, match="rule must be 1 to 256"):
        LogFilter.parse(rule="a\nb")


def test_the_logs_route_answers_400_for_a_bad_value(client) -> None:
    for params in ({"rule": "a\nb"}, {"rule": "x" * 257}, {"severity": "urgent"},
                   {"severity_gte": "p1"}):
        r = client.get("/api/logs", params=params)
        assert r.status_code == 400, (params, r.text)


# --------------------------------------------------------------------------- #
# 3. Native compilation (Elasticsearch, OpenSearch and Wazuh share it)
# --------------------------------------------------------------------------- #
def test_a_rule_compiles_to_every_identity_with_first_match_classification() -> None:
    prefs = Preferences(rule_catalog=[
        RuleDefinition(name="Web attack", match=RuleMatch(field="rule.id", op="prefix", value="9"), priority=60),
        RuleDefinition(name="XSS", match=RuleMatch(field="rule.id", op="prefix", value="941"), priority=50),
        RuleDefinition(name="XSS", match=RuleMatch(field="tags", op="tag", value="xss"), priority=70,
                       enabled=False),
    ])
    clause, kql = rule_identity_clause(prefs, "Web attack")
    should = clause["bool"]["should"]
    assert should[0] == exact_value_clause("event.module", "Web attack")
    assert should[1] == exact_value_clause("rule.name", "Web attack")
    # "Web attack" classifies only what the priority-50 "XSS" rule did not take.
    assert should[2] == {"bool": {"filter": [exact_value_clause("rule.id", "9", kind="prefix")],
                                  "must_not": [exact_value_clause("rule.id", "941", kind="prefix")]}}
    assert clause["bool"]["minimum_should_match"] == 1
    # The rendering describes the comparison the Console and Discover show.
    assert kql == ('(event.module : "Web attack" or rule.name : "Web attack" '
                   'or (rule.id : 9* and not (rule.id : 941*)))')
    # A disabled catalog rule never classifies anything.
    xss, _ = rule_identity_clause(prefs, "XSS")
    assert xss["bool"]["should"][2] == exact_value_clause("rule.id", "941", kind="prefix")
    assert len(xss["bool"]["should"]) == 3


def test_an_exact_value_clause_prefers_the_keyword_sub_field() -> None:
    """A ``term`` on an analysed ``text`` field compares lower-cased tokens, so every
    exact clause matches the ``.keyword`` sub-field when a document has one, and the
    field itself only when it does not (a keyword-mapped index)."""
    assert exact_value_clause("rule.name", "Web scanner") == {"bool": {
        "should": [
            {"term": {"rule.name.keyword": "Web scanner"}},
            {"bool": {"filter": [{"term": {"rule.name": "Web scanner"}}],
                      "must_not": [{"exists": {"field": "rule.name.keyword"}}]}},
        ],
        "minimum_should_match": 1,
    }}
    assert exact_value_clause("rule.id", "94", kind="prefix")["bool"]["should"][0] == {
        "prefix": {"rule.id.keyword": "94"}}
    # A field that already names its exact-value sub-field is matched as it is.
    assert exact_value_clause("rule.name.keyword", "x") == {"term": {"rule.name.keyword": "x"}}
    with pytest.raises(ValueError):
        exact_value_clause("rule.name", "x", kind="match")
    # The catalog's ``equals``, ``tag`` and the empty-value exclusion of ``exists`` too.
    prefs = Preferences(rule_catalog=[
        RuleDefinition(name="Tagged", match=RuleMatch(field="tags", op="tag", value="xss"), priority=10),
        RuleDefinition(name="Named", match=RuleMatch(field="rule.ruleset", op="exists"), priority=20),
    ])
    tagged, _ = rule_identity_clause(prefs, "Tagged")
    assert tagged["bool"]["should"][2] == exact_value_clause("tags", "xss")
    named, _ = rule_identity_clause(prefs, "Named")
    assert named["bool"]["should"][2]["bool"]["filter"][0]["bool"] == {
        "filter": [{"exists": {"field": "rule.ruleset"}}],
        "must_not": [exact_value_clause("rule.ruleset", "")],
    }


# The default dynamic mapping, emulated on the in-memory cluster: a document that carries
# ``<field>.keyword`` beside one of these fields has the field indexed as ``text``, so a
# ``term`` on the field compares lower-cased tokens (what Elasticsearch does), and the
# ``.keyword`` sub-field holds the whole value.
_ANALYSED = ("rule.name", "event.module")


def _analysed_term_match(original: Any):
    import re as _re

    from app.utils import dotted_get

    def term_match(src: dict[str, Any], field: str, value: Any, *, index: str = "") -> bool:
        if field in _ANALYSED and f"{field}.keyword" in src:
            actual = dotted_get(src, field)
            tokens = {t for t in _re.split(r"[^0-9a-zA-Z_]+", str(actual or "").lower()) if t}
            return str(value) in tokens
        return original(src, field, value, index=index)

    return term_match


def _text_mapped(doc: dict[str, Any]) -> dict[str, Any]:
    from app.utils import dotted_get

    out = dict(doc)
    for path in _ANALYSED:
        value = dotted_get(doc, path)
        if value is not None:
            out[f"{path}.keyword"] = value
    return out


def test_an_analysed_text_rule_field_is_filtered_exactly(client, monkeypatch) -> None:
    """On a ``text`` field a bare ``term`` misses every multi-word rule and matches one
    word inside other names; the exact clause reads the ``.keyword`` sub-field, so the
    rows, the per-source total and the rule summary all count the exact rule."""
    import app.es.fake as fake

    monkeypatch.setattr(fake, "_term_match", _analysed_term_match(fake._term_match))
    es = _es(client)
    for i in range(3):
        es.add_log(INDEX_B, _text_mapped(_doc(module="web", name="Web scanner user agent detected",
                                              ip=f"10.0.0.{i}")))
    es.add_log(INDEX_B, _text_mapped(_doc(module="auth", name="SSH brute force")))
    es.add_log(INDEX_B, _text_mapped(_doc(module="web2", name="Web scanner user agent detected again")))
    # A keyword-mapped index (no ``.keyword`` sub-field): the field holds whole values.
    es.add_log(INDEX_B, _doc(module="web", name="Web scanner user agent detected"))
    _add_source(client, "ecs", INDEX_B)

    # The emulation is analysed: a bare term matches one word inside another name.
    assert fake._matches({"term": {"rule.name": "ssh"}}, "x", _text_mapped(_doc(name="SSH brute force")))

    rule = "Web scanner user agent detected"
    body = _logs(client, rule=rule)
    assert body["count"] == 4 and {row["rule"] for row in body["logs"]} == {"web"}
    assert body["sources"][0]["exact"] is True and body["sources"][0]["total"] == 4
    assert body["matched"] == {"count": 4, "relation": "eq"}
    # One word of a name is not the rule (a bare term would match "SSH brute force" and
    # every scanner event), and the whole name still is.
    for word in ("ssh", "SSH", "scanner", "agent"):
        assert _logs(client, rule=word)["matched"] == {"count": 0, "relation": "eq"}, word
    assert _logs(client, rule="SSH brute force")["count"] == 1

    from app.api.routes_rule_summary import router as summary_router

    client.app.include_router(summary_router)
    summary = client.get("/api/rules/summary", params={"rule": rule, "window": "now-1d"}).json()
    assert summary["alerts"]["count"] == 4 and summary["alerts"]["count_relation"] == "eq"
    token = client.get("/api/rules/summary", params={"rule": "scanner", "window": "now-1d"}).json()
    assert token["alerts"]["count"] == 0


def test_a_level_compiles_to_a_raw_range_and_info_keeps_missing_values() -> None:
    clause, kql = severity_upper_clause("event.severity", 1.2, include_missing=True)
    assert clause == {"bool": {"should": [
        {"range": {"event.severity": {"lt": 1.2}}},
        {"bool": {"must_not": [{"exists": {"field": "event.severity"}}]}},
    ], "minimum_should_match": 1}}
    assert kql == "(event.severity < 1.2 or not event.severity : *)"
    bounded, text = severity_upper_clause("event.severity", 74.0, include_missing=False)
    assert bounded == {"range": {"event.severity": {"lt": 74.0}}} and text == "event.severity < 74"


class _CapturingES:
    """Records every body a connector sends; answers with no hits."""

    def __init__(self) -> None:
        self.bodies: list[dict[str, Any]] = []

    async def search_logs(self, index: str, body: dict[str, Any]) -> dict[str, Any]:
        self.bodies.append(body)
        return {"hits": {"total": {"value": 0, "relation": "eq"}, "hits": []}, "aggregations": {}}


def test_search_and_aggregate_build_one_population_and_plain_queries_are_unchanged() -> None:
    es = _CapturingES()
    conn = ElasticConnector(es, connector_id="elk")
    prefs = Preferences(rule_catalog=[])
    plain = StructuredQuery(rule="ssh_fail", time_from="now-1h", time_to="now")
    query = LogFilterQuery(rule_any="ssh_fail", severity_gte=48.0, severity_lt=74.0,
                           time_from="now-1h", time_to="now")

    async def run() -> None:
        await conn.search(prefs, plain)
        await conn.search(prefs, query)
        await conn.aggregate(prefs, query, ["ip"], None, 5)
        await conn.aggregate_composite(prefs, query, ["severity"], interval="12h")

    _run(run())
    plain_filters, search_filters, agg_filters, comp_filters = (
        b["query"]["bool"]["filter"] for b in es.bodies
    )
    # An ordinary StructuredQuery compiles exactly as before: no Round 14 clause, and
    # the default hit tracking. A filtered read counts its matches exactly past 10,000.
    assert not any("bool" in f for f in plain_filters[:-1])
    assert "track_total_hits" not in es.bodies[0]
    assert es.bodies[1]["track_total_hits"] is True
    identity, _ = rule_identity_clause(prefs, "ssh_fail")
    assert identity in search_filters
    assert {"range": {"event.severity": {"gte": 48.0}}} in search_filters
    assert {"range": {"event.severity": {"lt": 74.0}}} in search_filters

    def without_time(filters: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return [f for f in filters if "@timestamp" not in f.get("range", {})]

    assert without_time(search_filters) == without_time(agg_filters) == without_time(comp_filters)


# --------------------------------------------------------------------------- #
# 4. GET /api/logs, pull sources
# --------------------------------------------------------------------------- #
def test_a_rule_filter_is_exact_on_a_pull_source(client) -> None:
    es = _es(client)
    for i in range(3):
        es.add_log(INDEX_B, _doc(module="ssh_fail", name="SSH failed", ip=f"10.0.0.{i}"))
    es.add_log(INDEX_B, _doc(module="web_scan", name="Web scanner"))
    es.add_log(INDEX_B, _doc(module=None, name="ssh_fail"))          # the name identity
    es.add_log(INDEX_B, _doc(module="ssh_fail_extended", name="other"))  # never a substring
    _add_source(client, "ecs", INDEX_B)

    body = _logs(client, rule="ssh_fail")
    assert body["count"] == 4
    assert {row["rule"] for row in body["logs"]} == {"ssh_fail"}
    assert body["filters"] == {"rule": "ssh_fail", "severity": None, "severity_gte": None}
    assert body["sources"] == [{
        "source_id": "ecs", "source_name": body["sources"][0]["source_name"], "ok": True, "count": 4,
        "mode": "search", "truncated": False, "exact": True, "total": 4, "total_relation": "eq",
    }]
    assert body["matched"] == {"count": 4, "relation": "eq"}
    # The name is an identity too: the same events, found by what the row shows.
    assert _logs(client, rule="SSH failed")["count"] == 3
    assert _logs(client, rule="ssh")["count"] == 0


def _wazuh_alert(rule_id: str, description: str, level: int) -> dict[str, Any]:
    ts = datetime.fromtimestamp((to_millis(now_utc()) - 60_000) / 1000, tz=UTC).isoformat()
    return {"timestamp": ts, "rule": {"id": rule_id, "description": description, "level": level},
            "agent": {"name": "web01"}, "data": {"srcip": "198.51.100.23", "srcuser": "root"},
            "full_log": f"{description}"}


@pytest.mark.parametrize("kind", ["elasticsearch", "opensearch", "wazuh"])
def test_every_pull_connector_kind_filters_exactly(client, kind) -> None:
    """Elasticsearch, OpenSearch and Wazuh share the native compilation: the rule matches
    any identity, and a level is projected through the source's own scale (a Wazuh
    source is seeded with a 0 to 16 ceiling)."""
    es = _es(client)
    if kind == "wazuh":
        for rule_id, description, level in [("5710", "sshd: non-existent user", 12),
                                             ("5710", "sshd: non-existent user", 8),
                                             ("5501", "PAM: login session opened", 2),
                                             ("31101", "Web 400 error", 1)]:
            es.add_log(INDEX_A, _wazuh_alert(rule_id, description, level))
        config = {"data_view_pattern": INDEX_A, "time_field": "timestamp", "rule_field": "rule.id",
                  "rule_name_field": "rule.description", "severity_field": "rule.level",
                  "host_field": "agent.name", "source_ip_field": "data.srcip", "user_field": "data.srcuser"}
        rule_id, name, scale_levels = "5710", "sshd: non-existent user", {"critical": 1, "high": 1, "low": 1, "info": 1}
    else:
        for module, sev in [("ssh_fail", 80), ("ssh_fail", 50), ("web", 10), ("web", 5)]:
            es.add_log(INDEX_B, _doc(module=module, name=f"{module} name", severity=sev))
        config = {"data_view_pattern": INDEX_B}
        rule_id, name, scale_levels = "ssh_fail", "ssh_fail name", {"critical": 1, "high": 1, "low": 1, "info": 1}
    r = client.post("/api/sources", json={"id": "src", "source_type": kind, "config": config})
    assert r.status_code == 200, r.text
    by_id = _logs(client, rule=rule_id)
    by_name = _logs(client, rule=name)
    assert by_id["count"] == by_name["count"] == 2
    assert {row["id"] for row in by_id["logs"]} == {row["id"] for row in by_name["logs"]}
    assert by_id["sources"][0]["exact"] is True and by_id["sources"][0]["mode"] == "search"
    for level, expected in scale_levels.items():
        assert _logs(client, severity=level)["count"] == expected, (kind, level)
    assert _logs(client, severity="medium")["count"] == 0


def test_a_rule_with_spaces_and_non_ascii_letters_is_matched_exactly(client) -> None:
    _es(client).add_log(INDEX_B, _doc(module=None, name=NON_ASCII_RULE))
    _es(client).add_log(INDEX_B, _doc(module=None, name=NON_ASCII_RULE + " (2)"))
    _add_source(client, "ecs", INDEX_B)
    body = _logs(client, rule=NON_ASCII_RULE)
    assert body["count"] == 1 and body["logs"][0]["rule"] == NON_ASCII_RULE
    assert body["filters"]["rule"] == NON_ASCII_RULE


def test_levels_use_each_sources_own_scale(client) -> None:
    es = _es(client)
    # A 0 to 15 source: 13 Critical, 8 High, 4 Medium, 2 Low, 1 Info.
    for sev in (13, 8, 4, 2, 1):
        es.add_log(INDEX_A, _doc(module="wazuh_rule", severity=sev))
    # A 0 to 100 source: 80 Critical, 50 High, 30 Medium, 10 Low, 0 Info, missing Info.
    for sev in (80, 50, 30, 10, 0, None):
        es.add_log(INDEX_B, _doc(module="ecs_rule", severity=sev))
    _add_source(client, "wz", INDEX_A, scale=15)
    _add_source(client, "ecs", INDEX_B)

    def severities(**params: Any) -> list[tuple[str, float]]:
        body = _logs(client, **params)
        assert all(s["exact"] is True for s in body["sources"])
        return sorted((row["source_id"], row["severity"]) for row in body["logs"])

    assert severities(severity="critical") == [("ecs", 80.0), ("wz", 13.0)]
    assert severities(severity="high") == [("ecs", 50.0), ("wz", 8.0)]
    assert severities(severity="medium") == [("ecs", 30.0), ("wz", 4.0)]
    assert severities(severity="low") == [("ecs", 10.0), ("wz", 2.0)]
    assert severities(severity="info") == [("ecs", 0.0), ("ecs", 0.0), ("wz", 1.0)]
    assert severities(severity_gte="high") == [("ecs", 50.0), ("ecs", 80.0), ("wz", 8.0), ("wz", 13.0)]
    assert len(severities(severity_gte="info")) == 11
    assert severities(severity="low", severity_gte="high") == []
    assert severities(rule="wazuh_rule", severity_gte="medium") == [("wz", 4.0), ("wz", 8.0), ("wz", 13.0)]


def test_a_suite_rule_filters_to_the_events_it_classifies(client) -> None:
    state = client.app.state.tlsoc
    _run(_set_catalog(state, [
        RuleDefinition(name="XSS", match=RuleMatch(field="rule.id", op="prefix", value="941"), priority=50),
        RuleDefinition(name="Web attack", match=RuleMatch(field="rule.id", op="prefix", value="9"), priority=60),
    ]))
    es = _es(client)
    es.add_log(INDEX_B, _doc(module="modsec", rule_id="941100"))
    es.add_log(INDEX_B, _doc(module="modsec", rule_id="942100"))
    es.add_log(INDEX_B, _doc(module="modsec", rule_id="100"))
    _add_source(client, "ecs", INDEX_B)

    xss = _logs(client, rule="XSS")
    assert xss["count"] == 1 and xss["logs"][0]["rule"] == "XSS"
    attack = _logs(client, rule="Web attack")
    assert attack["count"] == 1 and attack["logs"][0]["rule"] == "Web attack"
    # The rule field is an identity too: every modsec event, whatever it is classified as.
    assert _logs(client, rule="modsec")["count"] == 3


async def _set_catalog(state: Any, catalog: list[RuleDefinition]) -> None:
    await state.update_prefs(state.prefs.model_copy(update={"rule_catalog": catalog}))


def test_the_rows_count_and_aggregate_agree_with_the_python_filter(client) -> None:
    """A randomised corpus: what the route returns is exactly what the Python form of
    the filter keeps, and the native aggregate counts the same events."""
    rng = random.Random(7)
    es = _es(client)
    base = to_millis(now_utc()) - 3_600_000
    docs = []
    for i in range(150):
        doc = _doc(module=rng.choice(["a", "b", "c", None]), name=rng.choice(["a", "n1", None]),
                   severity=rng.choice([None, 0, 1, 2, 3.3, 4, 7.2, 7.68, 8, 11.1, 12, 15, 40]),
                   ts_millis=base + i * 1000)
        docs.append(doc)
        es.add_log(INDEX_A, doc, doc_id=f"r{i}")
    _add_source(client, "wz", INDEX_A, scale=15)
    state = client.app.state.tlsoc
    prefs = state.prefs
    events = [RawEvent.from_hit({"_id": f"r{i}", "_index": INDEX_A, "_source": d}, prefs)
              for i, d in enumerate(docs)]
    for flt in (LogFilter(rule="a"), LogFilter(rule="n1", severity="info"),
                LogFilter(severity="high"), LogFilter(severity_gte="medium"),
                LogFilter(rule="c", severity_gte="low"), LogFilter(severity="critical")):
        params = {k: v for k, v in flt.echo().items() if v is not None}
        body = _logs(client, **params)
        expected = sorted(ev.id for ev in events if flt.matches_event(ev, scale_max=15, prefs=prefs))
        assert sorted(row["id"] for row in body["logs"]) == expected, params
        assert body["sources"][0]["exact"] is True

        async def native_total(flt: LogFilter = flt) -> int:
            conn = ElasticConnector(state.es, config={"data_view_pattern": INDEX_A}, connector_id="wz")
            query = log_rows._log_filter_query(
                StructuredQuery(time_from="now-24h", time_to="now", size=200), flt, 15.0,
            )
            agg = await conn.aggregate(prefs, query, [], None, 1)
            return agg.total

        assert client.portal.call(native_total) == len(expected), params


def test_the_matched_count_reaches_past_the_page_and_equals_the_rule_summary(client) -> None:
    """The Logs page states how many events the filter matched (SPEC §4.6.6), not only
    the rows it shows: an exact pull source with more matches than ``limit`` reports its
    whole total, the same number the rule summary counts for that rule and window."""
    from app.api.routes_rule_summary import router as summary_router

    client.app.include_router(summary_router)
    es = _es(client)
    now = to_millis(now_utc())
    for i in range(300):
        es.add_log(INDEX_B, _doc(module="ssh_fail", severity=80, ts_millis=now - 60_000 - i * 1000))
    es.add_log(INDEX_B, _doc(module="other", severity=80))
    _add_source(client, "ecs", INDEX_B)

    summary = client.get("/api/rules/summary", params={"rule": "ssh_fail"}).json()
    window = summary["window"]
    assert summary["alerts"]["count"] == 300 and summary["alerts"]["count_relation"] == "eq"
    assert summary["alerts"]["sources"][0]["exact"] is True
    body = _logs(client, rule="ssh_fail", limit=50, **{"from": window["from"], "to": window["to"]})
    assert body["count"] == 50 and body["truncated"] is True
    assert body["sources"][0]["total"] == 300 and body["sources"][0]["total_relation"] == "eq"
    assert body["matched"] == {"count": summary["alerts"]["count"], "relation": "eq"}


def test_a_failed_or_inexact_source_makes_the_matched_count_a_lower_bound(client, monkeypatch) -> None:
    es = _es(client)
    for _ in range(3):
        es.add_log(INDEX_B, _doc(module="ssh_fail"))
    es.add_log(INDEX_A, _doc(module="ssh_fail"))
    _add_source(client, "ecs", INDEX_B)
    _add_source(client, "wz", INDEX_A, scale=15)
    original = es.search_logs

    async def flaky(index: str, body: dict[str, Any]) -> dict[str, Any]:
        if index == INDEX_A:
            raise RuntimeError("tls handshake failed")
        return await original(index, body)

    monkeypatch.setattr(es, "search_logs", flaky)
    body = _logs(client, rule="ssh_fail")
    failed = next(s for s in body["sources"] if s["source_id"] == "wz")
    assert failed["ok"] is False and failed["total"] is None and failed["total_relation"] == "gte"
    assert body["matched"] == {"count": 3, "relation": "gte"}


def test_an_unfiltered_request_is_answered_as_before(client) -> None:
    _es(client).add_log(INDEX_B, _doc(module="x"))
    _add_source(client, "ecs", INDEX_B)
    body = _logs(client)
    assert "filters" not in body and "matched" not in body
    assert all("exact" not in s and "total" not in s for s in body["sources"])
    # An empty parameter is no filter.
    assert _logs(client, rule="", severity="", severity_gte="") == body


# --------------------------------------------------------------------------- #
# 5. GET /api/logs, push rings and Demo adapters
# --------------------------------------------------------------------------- #
def test_a_push_ring_is_filtered_by_the_route_and_never_exact(client) -> None:
    assert client.post("/api/sources", json={"id": "wh", "source_type": "webhook"}).status_code == 200
    now = datetime.now(UTC).isoformat()
    alerts = [{"src_ip": "5.5.5.5", "user": "eve", "severity": "high", "@timestamp": now,
               "signature": "ssh_bruteforce" if i < 3 else "port_scan", "id": f"evt-{i}"}
              for i in range(5)]
    assert client.post("/api/ingest/wh", json=alerts).status_code == 200

    body = _logs(client, rule="ssh_bruteforce")
    assert body["count"] == 3 and {row["rule"] for row in body["logs"]} == {"ssh_bruteforce"}
    (status,) = body["sources"]
    assert status["mode"] == "buffer" and status["exact"] is False and status["count"] == 3
    # The ring holds only recent events: what it holds is "at least" the matches.
    assert status["total"] == 3 and status["total_relation"] == "gte"
    assert body["matched"] == {"count": 3, "relation": "gte"}
    # The ring is scanned whole, so a small limit still says more exist.
    small = _logs(client, rule="ssh_bruteforce", limit=2)
    assert small["count"] == 2 and small["truncated"] is True
    assert _logs(client, rule="nothing")["count"] == 0


def test_a_filtered_push_ring_keeps_to_the_window_the_page_names(client) -> None:
    """While a filter is active, a ring read keeps to an explicit ``from``/``to`` as a
    pull search and the rule summary do, so the rows and ``matched`` describe the
    window the page names and equal the rule summary's ring count for that window. A
    side with no bound stays open, and an unfiltered ring read ignores the window as
    before."""
    from app.api.routes_rule_summary import router as summary_router

    client.app.include_router(summary_router)
    assert client.post("/api/sources", json={"id": "wh", "source_type": "webhook"}).status_code == 200
    now = datetime.now(UTC)

    def alert(i: int, *, days_ago: float, signature: str = "ssh_bruteforce") -> dict[str, Any]:
        return {"src_ip": "5.5.5.5", "user": f"u{i}", "severity": "high", "signature": signature,
                "@timestamp": (now - timedelta(days=days_ago)).isoformat(), "id": f"evt-{i}"}

    alerts = [alert(i, days_ago=0.1 * (i + 1)) for i in range(3)]          # inside 3 days
    alerts += [alert(3, days_ago=5), alert(4, days_ago=6)]                 # older than from
    alerts += [alert(5, days_ago=0.2, signature="port_scan")]              # another rule
    assert client.post("/api/ingest/wh", json=alerts).status_code == 200

    summary = client.get("/api/rules/summary", params={"rule": "ssh_bruteforce"}).json()
    window = summary["window"]
    assert summary["alerts"]["count"] == 3 and summary["alerts"]["count_relation"] == "gte"

    body = _logs(client, rule="ssh_bruteforce", **{"from": window["from"], "to": window["to"]})
    assert body["count"] == 3 and {row["user"] for row in body["logs"]} == {"u0", "u1", "u2"}
    (status,) = body["sources"]
    assert status["mode"] == "buffer" and status["exact"] is False
    assert status["total"] == 3 and status["total_relation"] == "gte"
    assert body["matched"] == {"count": summary["alerts"]["count"], "relation": "gte"}

    # A relative bound is resolved with the grammar a pull search uses.
    assert _logs(client, rule="ssh_bruteforce", **{"from": "now-3d"})["matched"]["count"] == 3
    # An upper bound alone leaves the older side open.
    older = _logs(client, rule="ssh_bruteforce", to=(now - timedelta(days=4)).isoformat())
    assert {row["user"] for row in older["logs"]} == {"u3", "u4"}
    # No bound (or one that does not parse) keeps the whole ring: still "at least".
    assert _logs(client, rule="ssh_bruteforce")["matched"] == {"count": 5, "relation": "gte"}
    assert _logs(client, rule="ssh_bruteforce", **{"from": "last tuesday"})["matched"]["count"] == 5
    # Without a filter a ring read still ignores from/to, key for key as before.
    assert _logs(client, **{"from": window["from"], "to": window["to"]})["count"] == 6


def test_the_ring_window_parses_each_bound_on_one_clock() -> None:
    sq = log_rows.browse_query(limit=10, time_from="2026-10-01T00:00:00Z", time_to="now")
    start, end = log_rows.ring_window_millis(sq)
    assert start == to_millis(datetime(2026, 10, 1, tzinfo=UTC))
    assert end is not None and abs(end - to_millis(now_utc())) < 5_000
    rel_start, rel_end = log_rows.ring_window_millis(log_rows.browse_query(limit=10, time_from="now-1h",
                                                                           time_to="now"))
    assert rel_end - rel_start == 3_600_000
    assert log_rows.ring_window_millis(log_rows.browse_query(limit=10)) == (None, None)
    event = RawEvent(id="e", timestamp_millis=1_000)
    assert log_rows.in_ring_window(event, 1_000, 1_000) is True       # both bounds inclusive
    assert log_rows.in_ring_window(event, 1_001, None) is False
    assert log_rows.in_ring_window(event, None, 999) is False
    assert log_rows.in_ring_window(RawEvent(id="u"), 1, None) is False  # no timestamp: the epoch


class _DemoConn:
    """A Demo adapter stand-in: matches a rule on the rule or rule name, applies a
    severity floor over its whole ring, returns at most ``size`` newest."""

    def __init__(self, events: list[RawEvent]) -> None:
        self.events = events

    async def search(self, prefs: Any, query: StructuredQuery) -> SearchResult:
        hits = [e for e in self.events
                if (query.rule is None or query.rule in (e.rule, e.rule_name))
                and (query.severity_gte is None or e.severity >= query.severity_gte)]
        return SearchResult(events=hits[: query.size], total=len(hits))


def _demo_event(i: int, rule: str, severity: float) -> RawEvent:
    return RawEvent(id=f"d{i}", rule=rule, severity=severity,
                    timestamp_millis=to_millis(now_utc()) - i * 1000)


def test_a_demo_adapter_is_exact_while_its_answer_holds_every_match() -> None:
    events = [_demo_event(i, "r1", 50.0 if i % 2 else 90.0) for i in range(10)]
    reader = log_rows.demo_filtered_reader("demo-1", prefs=Preferences(),
                                           demo_source_connector=lambda _sid: _DemoConn(events))
    # Rule and floor only: native, exact.
    read = _run(reader(log_rows.browse_query(limit=3), LogFilter(rule="r1", severity_gte="high")))
    assert read.exact is True and read.total == 10 and len(read.rows) == 3
    # An exact level below Critical needs an upper bound: exact while nothing was cut.
    read = _run(reader(log_rows.browse_query(limit=50), LogFilter(severity="high")))
    assert read.exact is True and read.total == 5 and {r["severity"] for r in read.rows} == {50.0}
    read = _run(reader(log_rows.browse_query(limit=4), LogFilter(severity="high")))
    assert read.exact is False and read.total is None
    assert {r["severity"] for r in read.rows} == {50.0}


def test_a_pull_row_that_fails_the_exact_recheck_is_dropped_and_the_source_is_not_exact() -> None:
    class _Conn:
        def __init__(self, *_a: Any, **_k: Any) -> None:
            pass

        def _effective_prefs(self, prefs: Any) -> Any:
            return prefs

        async def search(self, prefs: Any, query: Any) -> SearchResult:
            return SearchResult(events=[RawEvent(id="ok", rule="r1"), RawEvent(id="bad", rule="other")],
                                total=2)

    class _Client:
        async def close(self) -> None:
            return None

    src = SourceInstance(id="pull-a", source_type=SourceType.ELASTICSEARCH)
    original = log_rows._pull_connector
    log_rows._pull_connector = lambda _src, _client: _Conn()
    try:
        reader = log_rows.pull_filtered_reader(
            src, prefs=Preferences(), es_client_for_source=lambda _s: (_Client(), True), scale_max=100.0,
        )
        read = _run(reader(log_rows.browse_query(limit=5), LogFilter(rule="r1")))
    finally:
        log_rows._pull_connector = original
    assert [row["id"] for row in read.rows] == ["ok"]
    assert read.exact is False and read.total is None


def test_a_refused_rule_clause_falls_back_to_the_python_filter_honestly() -> None:
    """A cluster that refuses a suite rule's clause (a 400) is read once more without
    the native rule, filtered here, and exact only when that read held everything."""

    class _Refused(Exception):
        status_code = 400

    class _Conn:
        def __init__(self, total: int) -> None:
            self.total = total
            self.queries: list[Any] = []

        def _effective_prefs(self, prefs: Any) -> Any:
            return prefs

        async def search(self, prefs: Any, query: Any) -> SearchResult:
            self.queries.append(query)
            if getattr(query, "rule_any", None):
                raise _Refused("[prefix] query on a numeric field")
            events = [RawEvent(id="a", rule="XSS"), RawEvent(id="b", rule="other")]
            return SearchResult(events=events, total=self.total)

    class _Client:
        async def close(self) -> None:
            return None

    src = SourceInstance(id="pull-a", source_type=SourceType.ELASTICSEARCH)
    original = log_rows._pull_connector
    try:
        for total, exact in ((2, True), (900, False)):
            conn = _Conn(total)
            log_rows._pull_connector = lambda _src, _client, conn=conn: conn
            reader = log_rows.pull_filtered_reader(
                src, prefs=Preferences(rule_catalog=[]),
                es_client_for_source=lambda _s: (_Client(), True), scale_max=100.0,
            )
            read = _run(reader(log_rows.browse_query(limit=5), LogFilter(rule="XSS")))
            assert [row["id"] for row in read.rows] == ["a"]
            assert read.exact is exact and read.total == (1 if exact else None)
            assert conn.queries[1].rule_any is None
        # A refusal without a rule filter is a real error, not a fallback.
        conn = _Conn(2)
        conn.search = _raise_400  # type: ignore[method-assign]
        log_rows._pull_connector = lambda _src, _client: conn
        reader = log_rows.pull_filtered_reader(
            src, prefs=Preferences(), es_client_for_source=lambda _s: (_Client(), True), scale_max=100.0,
        )
        with pytest.raises(Exception, match="refused"):
            _run(reader(log_rows.browse_query(limit=5), LogFilter(severity="high")))
    finally:
        log_rows._pull_connector = original


async def _raise_400(prefs: Any, query: Any) -> SearchResult:
    class _Refused(Exception):
        status_code = 400

    raise _Refused("refused")


def test_rule_identities_cover_the_rule_its_name_and_raw_field_values() -> None:
    prefs = Preferences(rule_catalog=[])
    ev = RawEvent(id="1", rule="XSS", rule_name="Cross-site scripting",
                  source={"event": {"module": ["modsec", "waf"]}, "rule": {"name": "Cross-site scripting"}})
    assert event_rule_identities(ev, prefs) == {"XSS", "Cross-site scripting", "modsec", "waf"}
    assert event_rule_identities(ev) == {"XSS", "Cross-site scripting"}


# --------------------------------------------------------------------------- #
# 6. The composite aggregation (the exact two-level breakdown)
# --------------------------------------------------------------------------- #
def _seeded_connector(docs: list[dict[str, Any]]) -> tuple[ElasticConnector, Preferences]:
    es = InMemoryESClient()
    for i, doc in enumerate(docs):
        es.add_log(INDEX_A, doc, doc_id=f"c{i}")
    return ElasticConnector(es, config={"data_view_pattern": INDEX_A}, connector_id="wz"), Preferences(rule_catalog=[])


def test_composite_pairs_are_exact_paged_and_count_missing_values() -> None:
    base = to_millis(now_utc()) - 3_600_000
    docs = [_doc(module=m, severity=s, ts_millis=base + i * 60_000)
            for i, (m, s) in enumerate([("a", 8), ("a", 8), ("a", 12), ("b", 8), (None, 8), ("b", None)])]
    conn, prefs = _seeded_connector(docs)
    query = LogFilterQuery(time_from="now-24h", time_to="now")
    result = _run(conn.aggregate_composite(prefs, query, ["severity", "rule"], page_size=2))
    assert result is not None and result.complete is True and result.total == 6
    pairs = {(str(k[0]) if k[0] is not None else None, k[1]): n for k, n in result.rows}
    assert pairs == {("8", "a"): 2, ("12", "a"): 1, ("8", "b"): 1, ("8", None): 1, (None, "b"): 1}
    assert sum(n for _k, n in result.rows) == result.total
    capped = _run(conn.aggregate_composite(prefs, query, ["severity", "rule"], page_size=2,
                                                  max_buckets=2))
    assert capped is not None and capped.complete is False and len(capped.rows) == 2
    timed = _run(conn.aggregate_composite(prefs, query, ["severity"], interval="12h"))
    assert timed is not None and timed.interval == "12h"
    assert all(isinstance(keys[0], str) and keys[0].endswith("+00:00") for keys, _n in timed.rows)
    assert sum(n for _k, n in timed.rows) == 6
    # An unknown field or interval, or an id lookup, is refused (None: sample instead).
    assert _run(conn.aggregate_composite(prefs, query, ["nonsense"])) is None
    assert _run(conn.aggregate_composite(prefs, query, ["rule"], interval="5x")) is None
    assert _run(conn.aggregate_composite(prefs, LogFilterQuery(ids=["c1"]), ["rule"])) is None


def test_composite_retries_an_analysed_text_field_on_keyword_once() -> None:
    class _Text400(Exception):
        status_code = 400

    class _ES:
        def __init__(self, keyword_values: bool) -> None:
            self.fields: list[str] = []
            self.keyword_values = keyword_values

        async def search_logs(self, index: str, body: dict[str, Any]) -> dict[str, Any]:
            sources = body["aggs"]["pairs"]["composite"]["sources"]
            field = sources[0]["f_rule"]["terms"]["field"]
            self.fields.append(field)
            if not field.endswith(".keyword"):
                raise _Text400(f"Fielddata is disabled on [{field}]")
            key = "ssh_fail" if self.keyword_values else None
            return {"hits": {"total": {"value": 2}},
                    "aggregations": {"pairs": {"buckets": [{"key": {"f_rule": key}, "doc_count": 2}]}}}

    good = _ES(keyword_values=True)
    result = _run(ElasticConnector(good).aggregate_composite(
        Preferences(), LogFilterQuery(), ["rule"]))
    assert good.fields == ["event.module", "event.module.keyword"]
    assert result is not None and result.rows == [(("ssh_fail",), 2)]
    # A field with no ``.keyword`` sub-field answers every key missing: a mapping miss.
    miss = _ES(keyword_values=False)
    assert _run(ElasticConnector(miss).aggregate_composite(
        Preferences(), LogFilterQuery(), ["rule"])) is None


def test_the_level_series_counts_named_levels_whatever_the_raw_values() -> None:
    """A continuous severity has a distinct raw value per event, more than one composite
    read pages; the level series counts each named level natively (one bucket per time
    bucket), every event lands in exactly the level the projection gives it, and a
    missing value is Info."""
    from app.engine.severity_levels import level_ranges

    rng = random.Random(11)
    base = to_millis(now_utc()) - 3_600_000
    values: list[Any] = [round(rng.uniform(0, 15), 6) for _ in range(120)] + [None, None, -2, 99.5]
    docs = [_doc(module="r", severity=v, ts_millis=base + i * 20_000) for i, v in enumerate(values)]
    conn, prefs = _seeded_connector(docs)
    query = LogFilterQuery(rule_any="r", time_from="now-24h", time_to="now")
    capped = _run(conn.aggregate_composite(prefs, query, ["severity"], interval="1h", page_size=10,
                                           max_buckets=50))
    assert capped is not None and capped.complete is False
    series = _run(conn.aggregate_level_series(prefs, query, level_ranges(15), interval="1h"))
    assert series is not None and series.complete is True and series.total == len(values)
    counted: dict[str, int] = {}
    for (when, level), n in series.rows:
        assert isinstance(when, str) and when.endswith("+00:00")
        counted[level] = counted.get(level, 0) + n
    expected: dict[str, int] = {}
    for v in values:
        expected[level_of_raw(v, 15)] = expected.get(level_of_raw(v, 15), 0) + 1
    assert counted == expected and sum(counted.values()) == len(values)
    # An unbounded or Info-named range, or an id lookup, is refused (None).
    assert _run(conn.aggregate_level_series(prefs, query, {"high": (None, None)}, interval="1h")) is None
    assert _run(conn.aggregate_level_series(prefs, query, {"info": (0.0, 1.0)}, interval="1h")) is None
    assert _run(conn.aggregate_level_series(prefs, LogFilterQuery(ids=["c1"]), level_ranges(15),
                                            interval="1h")) is None
    # Overlapping ranges would count an event twice: not exact, so None.
    assert _run(conn.aggregate_level_series(prefs, query, {"a": (0.0, 10.0), "b": (5.0, None)},
                                            interval="1h")) is None


# --------------------------------------------------------------------------- #
# 7. Carve-outs, partial answers and push ceilings
# --------------------------------------------------------------------------- #
INDEX_MAIN = "logs-main-2026.10.28"
INDEX_NOISY = "logs-noisy-2026.10.28"


@pytest.fixture
def index_wildcards(monkeypatch):
    """Teach the in-memory fake the ``_index`` wildcard a real cluster evaluates (its own
    ``wildcard`` reads document fields only)."""
    from app.es import fake

    original = fake._matches

    def matches(query: dict[str, Any], doc_id: str, src: dict[str, Any], index: str = "") -> bool:
        spec = query.get("wildcard") if isinstance(query, dict) else None
        if isinstance(spec, dict) and set(spec) == {"_index"}:
            value = spec["_index"]
            pattern = value.get("value") if isinstance(value, dict) else value
            return fake._wildcard_regex(str(pattern), False).fullmatch(index) is not None
        return original(query, doc_id, src, index)

    monkeypatch.setattr(fake, "_matches", matches)


def _carved_source(client: TestClient, *, ignore: str = "logs-noisy-*") -> None:
    """One source reading ``logs-*`` with an IGNORE carve-out, 3 ``ssh_fail`` events in
    the live index and 7 in the muted one (the reviewer's probe)."""
    r = client.post("/api/sources", json={"id": "carved", "source_type": "elasticsearch", "config": {
        "index_patterns": [{"pattern": "logs-*", "role": "events"}, {"pattern": ignore, "role": "ignore"}],
    }})
    assert r.status_code == 200, r.text
    es = _es(client)
    for _ in range(3):
        es.add_log(INDEX_MAIN, _doc(module="ssh_fail"))
    for _ in range(7):
        es.add_log(INDEX_NOISY, _doc(module="ssh_fail"))


def test_an_ignore_carve_out_is_left_out_of_every_filtered_count(client, index_wildcards) -> None:
    """The rows never showed a muted event; now the match total, the composite and the
    rule summary do not count one either, so "Open all N in Logs" names the rows' N."""
    from app.api.routes_rule_summary import router as summary_router

    client.app.include_router(summary_router)
    _carved_source(client)
    body = _logs(client, rule="ssh_fail", **{"from": "now-1d"})
    assert body["count"] == 3
    (status,) = body["sources"]
    assert status["exact"] is True and status["total"] == 3 and status["total_relation"] == "eq"
    assert body["matched"] == {"count": 3, "relation": "eq"}
    summary = client.get("/api/rules/summary", params={"rule": "ssh_fail", "window": "now-1d"}).json()
    alerts = summary["alerts"]
    assert alerts["count"] == 3 and alerts["count_relation"] == "eq"
    assert alerts["sources"][0]["exact"] is True and alerts["status"] == "ok"
    assert summary["top_source_ips"]["rows"][0]["count"] == 3
    # The unfiltered browse shows the same population.
    assert _logs(client, **{"from": "now-1d"})["count"] == 3


def test_muted_events_in_a_native_answer_leave_the_count_at_least(client) -> None:
    """Should a native answer still hold muted events (here the fake cannot evaluate an
    ``_index`` wildcard), the connector drops them after the search, and their presence
    proves the native total counted events no row shows: no total, never "exact"."""
    from app.api.routes_rule_summary import router as summary_router

    client.app.include_router(summary_router)
    _carved_source(client)
    body = _logs(client, rule="ssh_fail", **{"from": "now-1d"})
    assert body["count"] == 3
    (status,) = body["sources"]
    assert status["exact"] is False and status["total"] is None and status["total_relation"] == "gte"
    assert body["matched"] == {"count": 3, "relation": "gte"}
    alerts = client.get("/api/rules/summary", params={"rule": "ssh_fail", "window": "now-1d"}).json()["alerts"]
    assert alerts["count"] == 3 and alerts["count_relation"] == "gte"
    assert alerts["sources"][0]["exact"] is False


def test_a_carve_out_that_cannot_be_expressed_natively_is_never_exact(client, index_wildcards) -> None:
    """``fnmatch`` reads ``[...]`` as a character class and an ``_index`` wildcard as
    literal text, so no native clause can mirror it: the source states "at least"."""
    from app.api.routes_rule_summary import router as summary_router

    client.app.include_router(summary_router)
    _carved_source(client, ignore="logs-[n]oisy-*")
    body = _logs(client, rule="ssh_fail", **{"from": "now-1d"})
    assert body["count"] == 3 and {r["source_id"] for r in body["logs"]} == {"carved"}
    (status,) = body["sources"]
    assert status["exact"] is False and status["total"] is None
    assert body["matched"] == {"count": 3, "relation": "gte"}
    alerts = client.get("/api/rules/summary", params={"rule": "ssh_fail", "window": "now-1d"}).json()["alerts"]
    assert alerts["count"] == 3 and alerts["count_relation"] == "gte"
    assert alerts["sources"][0]["exact"] is False
    assert alerts["reason"] == "Counted from the newest 200 events of the source."


def test_the_carve_out_clauses_mirror_the_longest_pattern_attribution() -> None:
    """Each IGNORE feed excludes what it owns: what it matches unless a feed that wins
    over it (longer, or as long and listed earlier, enabled or not) matches too."""

    def conn(feeds: list[Any]) -> ElasticConnector:
        return ElasticConnector(InMemoryESClient(), config={"index_patterns": feeds}, connector_id="c")

    plain = conn([{"pattern": "logs-*", "role": "events"}])
    assert plain.carve_out_clauses() == ([], [], True) and plain.carve_outs_native() is True

    carved = conn([
        {"pattern": "logs-*", "role": "events"},
        {"pattern": "logs-noisy-*", "role": "ignore"},
        {"pattern": "logs-noisy-keep-*", "role": "alerts", "enabled": False},
        {"pattern": "logs-noise1-*", "role": "events"},
    ])
    clauses, kql, native = carved.carve_out_clauses()
    assert native is True
    assert clauses == [{"bool": {"must_not": [{"bool": {
        "filter": [{"wildcard": {"_index": {"value": "logs-noisy-*"}}}],
        "must_not": [{"wildcard": {"_index": {"value": "logs-noisy-keep-*"}}},
                     {"wildcard": {"_index": {"value": "logs-noise1-*"}}}],
    }}]}}]
    assert kql == ["not (_index : logs-noisy-* and not (_index : logs-noisy-keep-* or _index : logs-noise1-*))"]
    # The mirror agrees with the attribution the union search drops by, index by index.
    for index in ("logs-main-1", "logs-noisy-1", "logs-noisy-keep-1", "logs-noise1-1"):
        feed = carved._feed_for_index(index)
        muted = feed is not None and feed.role.value == "ignore"
        assert muted is (index == "logs-noisy-1"), index

    # A muted feed with no winner over it: a plain exclusion; a ``:`` is escaped in KQL.
    only = conn([{"pattern": "remote:logs-*", "role": "ignore"}, {"pattern": "logs-*", "role": "events"}])
    clauses, kql, native = only.carve_out_clauses()
    assert native is True and kql == ["not _index : remote\\:logs-*"]
    assert clauses == [{"bool": {"must_not": [{"wildcard": {"_index": {"value": "remote:logs-*"}}}]}}]

    for bad in ("logs-[n]oisy-*", "logs-a-*,logs-b-*", "-logs-*", "<logs-{now/d}>", "logs\\-*"):
        unsafe = conn([{"pattern": "logs-*", "role": "events"}, {"pattern": bad, "role": "ignore"}])
        assert unsafe.carve_out_clauses() == ([], [], False), bad
        assert unsafe.carve_outs_native() is False
    # An unexpressible LIVE pattern that wins over a muted one is just as unsafe.
    winner = conn([{"pattern": "logs-*", "role": "ignore"}, {"pattern": "logs-[a]-*", "role": "events"}])
    assert winner.carve_outs_native() is False


def test_only_a_filtered_read_carries_the_carve_out_clause() -> None:
    """Every existing body (an ordinary ``StructuredQuery``) is unchanged; a
    ``LogFilterQuery`` search and its aggregations carry the same mute."""
    seen: list[dict[str, Any]] = []

    class _Spy(InMemoryESClient):
        async def search_logs(self, index: str, body: dict[str, Any]) -> dict[str, Any]:
            seen.append(body)
            return await super().search_logs(index, body)

    feeds = [{"pattern": "logs-*", "role": "events"}, {"pattern": "logs-noisy-*", "role": "ignore"}]
    conn = ElasticConnector(_Spy(), config={"index_patterns": feeds}, connector_id="c")
    prefs = Preferences(rule_catalog=[])
    mute = conn.carve_out_clauses()[0][0]
    _run(conn.search(prefs, StructuredQuery(rule="r")))
    assert mute not in seen[-1]["query"]["bool"]["filter"]
    _run(conn.search(prefs, LogFilterQuery(rule_any="r")))
    assert mute in seen[-1]["query"]["bool"]["filter"]
    _run(conn.aggregate(prefs, LogFilterQuery(rule_any="r"), ["ip"]))
    assert mute in seen[-1]["query"]["bool"]["filter"]
    _run(conn.aggregate_composite(prefs, LogFilterQuery(rule_any="r"), ["severity"]))
    assert mute in seen[-1]["query"]["bool"]["filter"]


def _partial(es: InMemoryESClient, monkeypatch, *, timed_out: bool = False) -> None:
    """Every log search answers HTTP 200 from part of its data: one of two shards failed
    (or the search timed out), as a cluster does with ``allow_partial_search_results``."""
    original = es.search_logs

    async def partial(index: str, body: dict[str, Any]) -> dict[str, Any]:
        resp = dict(await original(index, body))
        if timed_out:
            resp["timed_out"] = True
        else:
            resp["_shards"] = {"total": 2, "successful": 1, "skipped": 0, "failed": 1}
        return resp

    monkeypatch.setattr(es, "search_logs", partial)


def test_completeness_reads_failed_shards_and_timeouts_but_not_skipped_shards() -> None:
    from app.connectors.elastic import response_is_complete

    assert response_is_complete({"hits": {"hits": []}}) is True
    assert response_is_complete(None) is True
    assert response_is_complete({"_shards": {"total": 5, "successful": 3, "skipped": 2, "failed": 0}}) is True
    assert response_is_complete({"_shards": {"total": 2, "failed": 1}}) is False
    assert response_is_complete({"_shards": {"failed": "x"}}) is False
    assert response_is_complete({"timed_out": True, "_shards": {"failed": 0}}) is False
    partial = SearchResult(events=[], total=4, raw={"_shards": {"failed": 1}, "hits": {"total": {"value": 4}}})
    assert log_rows.search_total_relation(partial) == "gte"
    assert log_rows.search_total_relation(SearchResult(events=[], total=4, raw={"hits": {}})) == "eq"


@pytest.mark.parametrize("timed_out", [False, True])
def test_a_partial_answer_is_never_an_exact_count(client, monkeypatch, timed_out) -> None:
    """A failed shard (or a timeout) leaves its hits out of the rows, the total and every
    aggregation: Logs states "at least", and the rule summary neither counts exactly nor
    calls its chart or top lists exact."""
    from app.api.routes_rule_summary import router as summary_router

    client.app.include_router(summary_router)
    es = _es(client)
    for i in range(4):
        es.add_log(INDEX_B, _doc(module="ssh_fail", ip=f"203.0.113.{i}"))
    _add_source(client, "ecs", INDEX_B)
    _partial(es, monkeypatch, timed_out=timed_out)

    body = _logs(client, rule="ssh_fail")
    (status,) = body["sources"]
    assert body["count"] == 4 and status["exact"] is False
    assert status["total"] == 4 and status["total_relation"] == "gte"
    assert body["matched"] == {"count": 4, "relation": "gte"}

    summary = client.get("/api/rules/summary", params={"rule": "ssh_fail"}).json()
    alerts = summary["alerts"]
    assert alerts["count"] == 4 and alerts["count_relation"] == "gte"
    assert alerts["sources"][0]["exact"] is False
    assert alerts["first_seen"] is None
    assert "exact" not in (alerts["reason"] or "").lower()
    assert "Part of the log store did not answer" in alerts["reason"]
    for name in ("top_source_ips", "top_targets"):
        assert summary[name]["exact"] is False
        assert "Part of the log store did not answer" in summary[name]["reason"]


@pytest.mark.parametrize("timed_out", [False, True])
def test_a_partial_answer_counts_the_same_floor_in_logs_and_the_rule_summary(
    client, monkeypatch, timed_out,
) -> None:
    """More matches than one read returns, answered from part of the data: Logs keeps the
    native total as its "at least" bound, and the rule sheet counts that same floor (SPEC
    §4.6.6, "Open all N in Logs"), never just the rows of the one read its chart is
    drawn from. Its reason says part of the log store did not answer, not that it
    counted a sample."""
    from app.api.routes_rule_summary import SAMPLE_PER_SOURCE
    from app.api.routes_rule_summary import router as summary_router

    client.app.include_router(summary_router)
    es = _es(client)
    matches = SAMPLE_PER_SOURCE + 50
    for i in range(matches):
        es.add_log(INDEX_B, _doc(module="ssh_fail", ip=f"10.0.{i // 200}.{i % 200}"))
    es.add_log(INDEX_B, _doc(module="other_rule"))
    _add_source(client, "ecs", INDEX_B)
    _partial(es, monkeypatch, timed_out=timed_out)

    body = _logs(client, rule="ssh_fail")
    (status,) = body["sources"]
    assert body["count"] == SAMPLE_PER_SOURCE and status["exact"] is False
    assert status["total"] == matches and status["total_relation"] == "gte"
    assert body["matched"] == {"count": matches, "relation": "gte"}

    summary = client.get("/api/rules/summary", params={"rule": "ssh_fail"}).json()
    alerts = summary["alerts"]
    assert alerts["count"] == body["matched"]["count"] == matches
    assert alerts["count_relation"] == body["matched"]["relation"] == "gte"
    assert alerts["sources"] == [{"id": "ecs", "name": alerts["sources"][0]["name"], "exact": False}]
    assert alerts["first_seen"] is None and alerts["last_seen"] is None
    reason = alerts["reason"]
    assert reason.startswith("Part of the log store did not answer for the source, so these are at least the alerts.")
    assert f"The chart and top lists use the newest {SAMPLE_PER_SOURCE} events of the source." in reason
    assert "Counted from the newest" not in reason and "exact" not in reason.lower()
    # The chart is drawn from the one read: it never claims more events than it holds.
    charted = sum(p[lv] for p in alerts["series"]["points"] for lv in LEVELS_DESCENDING)
    assert charted == SAMPLE_PER_SOURCE
    for name in ("top_source_ips", "top_targets"):
        assert summary[name]["exact"] is False
        assert summary[name]["reason"].startswith(
            "Part of the log store did not answer for the source, so a count may be low or a value missing."
        )


def test_a_partial_answer_whose_rows_disagree_counts_only_the_rows(client, monkeypatch) -> None:
    """The floor is the native total only while every returned row carries the rule: a
    row the native clause matched that the rule identity does not leaves the total
    meaningless, so Logs and the rule summary both count the rows they kept."""
    from app.api.routes_rule_summary import router as summary_router

    client.app.include_router(summary_router)
    es = _es(client)
    for i in range(3):
        es.add_log(INDEX_B, _doc(module="ssh_fail", ip=f"203.0.113.{i}"))
    _add_source(client, "ecs", INDEX_B)
    _partial(es, monkeypatch)
    original = es.search_logs

    async def stray(index: str, body: dict[str, Any]) -> dict[str, Any]:
        # The native answer carries one extra hit that is not this rule's event.
        resp = dict(await original(index, body))
        hits = dict(resp.get("hits") or {})
        listed = list(hits.get("hits") or [])
        if listed and int(body.get("size") or 0) > 1:
            extra = dict(listed[0])
            extra["_id"] = "stray"
            extra["_source"] = _doc(module="other_rule")
            hits["hits"] = [extra, *listed]
            total = hits.get("total")
            if isinstance(total, dict):
                hits["total"] = {**total, "value": int(total.get("value") or 0) + 40}
            resp["hits"] = hits
        return resp

    monkeypatch.setattr(es, "search_logs", stray)
    body = _logs(client, rule="ssh_fail")
    assert body["matched"] == {"count": 3, "relation": "gte"}
    alerts = client.get("/api/rules/summary", params={"rule": "ssh_fail"}).json()["alerts"]
    assert alerts["count"] == body["matched"]["count"] == 3
    assert alerts["count_relation"] == "gte"
    assert "Counted from the newest" in alerts["reason"]


def test_every_aggregation_declines_a_partial_answer(monkeypatch) -> None:
    from app.engine.severity_levels import level_ranges

    conn, prefs = _seeded_connector([_doc(module="r", severity=50) for _ in range(3)])
    _partial(conn._es, monkeypatch)
    query = LogFilterQuery(rule_any="r", time_from="now-24h", time_to="now")
    assert _run(conn.aggregate(prefs, query, ["ip"], "1h")) is None
    assert _run(conn.aggregate_composite(prefs, query, ["severity"], interval="1h")) is None
    assert _run(conn.aggregate_level_series(prefs, query, level_ranges(100), interval="1h")) is None


def test_a_push_ring_is_read_on_the_canonical_score_not_its_declared_ceiling(client) -> None:
    """A pushed record's native severity is projected through its source's declared
    ceiling once, on ingest (5 on 0 to 16 is the canonical 30, Medium). The ring is read
    on the default ceiling, so the level the filter and the rule summary give it is the
    one ingest gave it; projecting 30 through 16 again would read Critical."""
    from app.api.routes_rule_summary import router as summary_router

    client.app.include_router(summary_router)
    r = client.post("/api/sources", json={"id": "wh", "source_type": "webhook", "severity_scale_max": 16})
    assert r.status_code == 200, r.text
    now = datetime.now(UTC).isoformat()
    assert client.post("/api/ingest/wh", json=[
        {"src_ip": "5.5.5.5", "event": {"severity": 5}, "@timestamp": now, "signature": "ssh_fail", "id": "e1"},
    ]).status_code == 200
    (row,) = _logs(client, rule="ssh_fail")["logs"]
    assert row["severity"] == 30.0 and level_of_raw(5, 16) == "medium"
    assert _logs(client, severity="medium")["count"] == 1
    assert _logs(client, severity="critical")["count"] == 0
    assert _logs(client, severity_gte="high")["count"] == 0
    # The same ring through the chat's all-sources fan-out (one target builder).
    (target,) = client.app.state.tlsoc._chat_browse_targets()
    assert target.mode == "buffer" and target.scale_max == 100.0
    alerts = client.get("/api/rules/summary", params={"rule": "ssh_fail"}).json()["alerts"]
    totals = {lv: sum(p[lv] for p in alerts["series"]["points"]) for lv in LEVELS_DESCENDING}
    assert totals == {"critical": 0, "high": 0, "medium": 1, "low": 0, "info": 0}


# --------------------------------------------------------------------------- #
# 8. GET /api/cases: rule and closed_by
# --------------------------------------------------------------------------- #
def _case(cid: str, **kw: Any) -> Case:
    base: dict[str, Any] = {
        "case_id": cid,
        "cluster_signature": f"sig-{cid}",
        "source_surface": SourceSurface.AUTOMATED_SCAN,
        "entity": Entity(type=EntityType.IP, value="10.0.0.1"),
        "created_at": (datetime.now(UTC) - timedelta(hours=2)).isoformat(),
        "title": f"Case {cid}",
    }
    base.update(kw)
    return Case(**base)


def _seed_cases(client: TestClient) -> None:
    cases = [
        _case("c1", rule_ids=["r-ssh"], status=CaseStatus.CLOSED, decision_by=DecisionBy.AGENT,
              verdict=Verdict.FALSE_POSITIVE),
        _case("c2", rule_ids=["r-ssh", "r-web"], status=CaseStatus.OPEN),
        _case("c3", rule_ids=["R-SSH"], status=CaseStatus.RESOLVED, decision_by=DecisionBy.ANALYST),
        _case("c4", rule_ids=["r-ssh"], status=CaseStatus.CLOSED, decision_by=DecisionBy.ANALYST_POLICY,
              analyst_policy={"policy_id": "p1"}),
        _case("c5", rule_ids=[], status=CaseStatus.CLOSED),
        _case("c6", rule_ids=["r-web"], status=CaseStatus.RESOLVED, decision_by=DecisionBy.SYSTEM),
        _case("c7", rule_ids=[NON_ASCII_RULE], status=CaseStatus.NEEDS_HUMAN),
    ]
    state = client.app.state.tlsoc

    async def seed() -> None:
        for case in cases:
            await state.cases.save(case)

    client.portal.call(seed)


def _case_ids(client: TestClient, **params: Any) -> tuple[list[str], dict[str, Any]]:
    r = client.get("/api/cases", params={"limit": 100, **params})
    assert r.status_code == 200, r.text
    body = r.json()
    return sorted(c["case_id"] for c in body["cases"]), body


def test_the_cases_rule_filter_is_exact_on_rule_ids(case_client) -> None:
    client = case_client
    _seed_cases(client)
    ids, body = _case_ids(client, rule="r-ssh")
    assert ids == ["c1", "c2", "c4"] and body["total"] == 3
    assert body["rule_applied"] == "r-ssh"
    assert _case_ids(client, rule="R-SSH")[0] == ["c3"]       # case sensitive, as stored
    assert _case_ids(client, rule="ssh")[0] == []              # never a substring
    assert _case_ids(client, rule=NON_ASCII_RULE)[0] == ["c7"]
    assert _case_ids(client, rule="r-web", status_group="active")[0] == ["c2"]


def test_closed_by_takes_the_engines_values(case_client) -> None:
    client = case_client
    _seed_cases(client)
    assert _case_ids(client, closed_by="agent")[0] == ["c1"]
    assert _case_ids(client, closed_by="analyst")[0] == ["c3"]
    assert _case_ids(client, closed_by="analyst_policy")[0] == ["c4"]
    # No recorded decider, or deterministic routing: the system closed it.
    assert _case_ids(client, closed_by="system")[0] == ["c5", "c6"]
    ids, body = _case_ids(client, closed_by="AGENT", rule="r-ssh")
    assert ids == ["c1"] and body["closed_by_applied"] == "agent"
    # An open case has no closer, whatever filter asks.
    assert _case_ids(client, closed_by="agent", status="open")[0] == []
    # Only the engine's four values are accepted (SPEC §11.1 contract resolution 8):
    # ``human`` is not an alias of ``analyst``, it is refused like any unknown value,
    # and the refusal names the accepted values.
    for bad in ("human", "nobody", "humans", "analysts", "agent,analyst"):
        r = client.get("/api/cases", params={"closed_by": bad})
        assert r.status_code == 400, (bad, r.text)
        detail = r.json()["detail"]
        assert "closed_by" in detail
        for value in ("agent", "analyst", "analyst_policy", "system"):
            assert f"'{value}'" in detail
    # An empty value is no filter at all (the legacy envelope, no echo).
    r = client.get("/api/cases", params={"closed_by": ""})
    assert r.status_code == 200 and "closed_by_applied" not in r.json()


def test_a_cancelled_queue_scan_releases_its_snapshot() -> None:
    """A caller's time budget cancels the scan between pages; ``except Exception`` never
    sees a cancellation, so the read snapshot is released in ``finally`` (a cluster caps
    open snapshots, and a stranded one lives for minutes)."""
    from types import SimpleNamespace

    from app.api.routes import _scan_case_queue

    blocked = asyncio.Event()
    closed: list[Any] = []

    class _Store:
        async def scan_page(self, *, limit: int, cursor: Any = None, **_kw: Any):
            if cursor is None:
                return [{"case_id": "c1", "status": "open", "created_at": "2026-10-26T00:00:00+00:00",
                         "rule_ids": ["r"]}], {"pit": "p-1"}, None, "snapshot"
            await blocked.wait()  # the next page never arrives
            raise AssertionError("unreachable")

        async def close_scan_cursor(self, cursor: Any) -> None:
            closed.append(cursor)

    state = SimpleNamespace(execution_prefs=Preferences(rule_catalog=[]), cases=_Store())

    async def run() -> None:
        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(_scan_case_queue(
                state, statuses=None, surface=None, entity=None, terms=[], assignee="", severity=None,
                lo=None, hi=None, sort_field="created_at", sort_order="desc", limit=5, offset=0, rule="r",
            ), timeout=0.05)

    _run(run())
    assert closed == [{"pit": "p-1"}]


def test_the_cases_rule_value_is_validated(case_client) -> None:
    client = case_client
    for bad in ("a\nb", "x" * 257, "a b"):
        assert client.get("/api/cases", params={"rule": bad}).status_code == 400
    _seed_cases(client)
    ids, body = _case_ids(client, rule="")
    assert len(ids) == 7 and "rule_applied" not in body


def test_the_queue_search_matches_rule_values(case_client) -> None:
    client = case_client
    _seed_cases(client)
    assert _case_ids(client, q="r-web")[0] == ["c2", "c6"]
    assert _case_ids(client, q="anmeldung")[0] == ["c7"]
