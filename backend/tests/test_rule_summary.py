"""Round 14 (SPEC §4.6.2): ``GET /api/rules/summary``, one rule's picture.

What this pins:

* **Sections.** Alerts (count, relation, first and last seen, a severity series by named
  level, the sources that answered), top source IPs, top targets, cases (count, still
  open, the analyst-outcome family, the 5 newest), definition, tuning and analyst
  policy, each with its own status.
* **Honesty.** An Elastic-family source counts exactly (``eq``); a push source's ring is
  "at least" (``gte``) and says so; when no source can aggregate the alert sections are
  ``unsupported`` with the reason; a failing source degrades alone; ``sources[].exact``
  means the COUNT is exact (as in ``GET /api/logs``); each reason names its own cause
  (a sample, a live-tail ring, a severity read past its bucket cap) and never calls an
  exact count sampled; a first or last event is stated only when it is proven; a
  merged top list is exact only when no source's own list is approximate (a multi-shard
  count error the store reports, or no bound at all), no listed count can be missing a
  source's share and no value left off can outrank its last row; an alert section that
  is denied or fails never states an exact count.
* **Levels.** A 0 to 15 and a 0 to 10 source are projected through their own ceilings
  before they are merged with a 0 to 100 source; every level is present, zeros included,
  and the series adds up to the count.
* **Cases.** The count equals ``GET /api/cases?rule=`` (the population "Show the N cases"
  opens, all time whatever the window); analyst outcomes never count an analyst-policy
  close as graded; row-level scope hides the section (D16); a scan that stopped on its
  own never lists a partial "newest"; one rule's section is read once for concurrent
  sheets and reused for a short while, never after a failure or a Demo switch.
* **One answer with Logs.** A row the native rule clause matched that the rule identity
  does not makes the source "at least" in the sheet exactly as it does in Logs; a push
  ring is read on the canonical score its events were normalised to on ingest.
* **Tuning.** The section shows the Tuning page's proposal for the rule with the same
  gates (shadow evaluation, the auto-apply policy), never a rolled-back change as the
  last one, and reuses its view of every terminal case for a short while.
* **Boundaries.** Each section checks its own grant (``sources:read``, ``cases:read``,
  ``rules:read``, ``automation:read``); bad input is a 400 naming the parameter; an
  all-time window echoes the epoch as ``from`` so a Logs link reads the same events;
  Demo Mode reads the Demo sources and cases; a cancelled case read releases its
  snapshot; no model call (#6) and no audit row (a read); no em dash, en dash or
  "playbook" in any Console-authored string.
"""

from __future__ import annotations

import re
from collections import Counter
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.api import routes_rule_summary
from app.api.deps import require_auth
from app.api.routes import router as monolith_router
from app.api.routes_rule_summary import pick_bucket
from app.api.routes_rule_summary import router as summary_router
from app.api.routes_tuning import router as tuning_router
from app.config import AnalystRulePolicy, RuleDefinition, RuleMatch, Secrets
from app.constants import CaseStatus, DecisionBy, Disposition, EntityType, SourceSurface, Verdict
from app.es.fake import InMemoryESClient
from app.llm.providers import MockProvider
from app.models import Case, Entity, FeedbackEntry, RuleSummary
from app.state import AppState
from app.stores.tuning import TuningRecord

UTC = timezone.utc
INDEX_WZ = "wazuh-alerts-2026.10.26"
INDEX_QR = "qradar-2026.10.26"
INDEX_ECS = "ecs-2026.10.26"
RULE = "ssh_fail"


# --------------------------------------------------------------------------- #
# Fixtures
# --------------------------------------------------------------------------- #
def _doc(*, module: str = RULE, severity: Any = 8, ip: str = "198.51.100.23", host: str = "web01",
         user: str = "root", hours_ago: float = 1.0) -> dict[str, Any]:
    ts = datetime.now(UTC) - timedelta(hours=hours_ago)
    event: dict[str, Any] = {"module": module, "action": "login", "outcome": "failure"}
    if severity is not None:
        event["severity"] = severity
    return {
        "@timestamp": ts.isoformat(),
        "source": {"ip": ip},
        "user": {"name": user},
        "host": {"name": host},
        "event": event,
        "rule": {"name": f"{module} name"},
        "message": f"{module} from {ip}",
    }


def _case(cid: str, *, hours_ago: float = 2.0, **kw: Any) -> Case:
    base: dict[str, Any] = {
        "case_id": cid,
        "case_number": f"CASE-{cid[-3:].zfill(6)}",
        "cluster_signature": f"sig-{cid}",
        "source_surface": SourceSurface.AUTOMATED_SCAN,
        "entity": Entity(type=EntityType.IP, value="198.51.100.23"),
        "created_at": (datetime.now(UTC) - timedelta(hours=hours_ago)).isoformat(),
        "title": f"Case {cid}",
    }
    base.update(kw)
    return Case(**base)


def _feedback(outcome: str) -> list[FeedbackEntry]:
    return [FeedbackEntry(actual_outcome=outcome, ts=(datetime.now(UTC) - timedelta(minutes=30)).isoformat())]


def _cases() -> list[Case]:
    return [
        # An analyst confirmed it a true positive; still open.
        _case("c-001", hours_ago=1, rule_ids=[RULE], status=CaseStatus.ESCALATED,
              verdict=Verdict.TRUE_POSITIVE, feedback=_feedback("true_positive")),
        # Auto-closed false positive an analyst confirmed benign.
        _case("c-002", hours_ago=2, rule_ids=[RULE, "web_scan"], status=CaseStatus.CLOSED,
              decision_by=DecisionBy.AGENT, verdict=Verdict.FALSE_POSITIVE,
              feedback=_feedback("false_positive")),
        # Closed by an analyst rule policy: never graded, whatever feedback says.
        _case("c-003", hours_ago=3, rule_ids=[RULE], status=CaseStatus.CLOSED,
              decision_by=DecisionBy.ANALYST_POLICY, disposition=Disposition.FALSE_POSITIVE,
              analyst_policy={"policy_id": "p1"}, feedback=_feedback("false_positive")),
        # Waiting for an analyst, created long ago (the cases section is all time).
        _case("c-004", hours_ago=24 * 40, rule_ids=[RULE], status=CaseStatus.NEEDS_HUMAN,
              verdict=Verdict.NEEDS_HUMAN),
        # Another rule, a case-variant of this rule: never counted.
        _case("c-005", hours_ago=1, rule_ids=["SSH_FAIL"], status=CaseStatus.OPEN),
        _case("c-006", hours_ago=4, rule_ids=["web_scan"], status=CaseStatus.OPEN),
    ]


def _app(state_box: dict[str, Any], *, secrets: Secrets, auth: bool = False,
         denies: dict[str, list[str]] | None = None) -> FastAPI:
    mock = MockProvider()

    @asynccontextmanager
    async def lifespan(api: FastAPI):
        state = AppState.create(secrets=secrets, es=InMemoryESClient(),
                                provider_overrides={"anthropic": mock, "openai": mock, "mock": mock})
        await state.startup(start_poller=False)
        prefs = state.prefs.model_copy(update={"setup_complete": True, "rule_catalog": []})
        if auth:
            prefs = prefs.model_copy(update={"rbac": prefs.rbac.model_copy(update={
                "enabled": True, "denies": {"analyst_tier1": denies or {}},
            })})
        await state.update_prefs(prefs)
        api.state.tlsoc = state
        state_box["state"] = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    deps = [Depends(require_auth)] if auth else []
    api.include_router(monolith_router, dependencies=deps)
    api.include_router(summary_router, dependencies=deps)
    api.include_router(tuning_router, dependencies=deps)
    return api


@pytest.fixture(autouse=True)
def _fresh_tuning_view():
    routes_rule_summary.invalidate_summary_views()
    yield
    routes_rule_summary.invalidate_summary_views()


@pytest.fixture
def box(secrets):
    holder: dict[str, Any] = {}
    with TestClient(_app(holder, secrets=secrets)) as client:
        holder["client"] = client
        yield holder


def _client(box: dict[str, Any]) -> TestClient:
    return box["client"]


def _state(box: dict[str, Any]) -> AppState:
    return box["state"]


def _add_source(client: TestClient, sid: str, pattern: str, *, scale: float | None = None) -> None:
    body: dict[str, Any] = {"id": sid, "source_type": "elasticsearch", "config": {"data_view_pattern": pattern}}
    if scale is not None:
        body["severity_scale_max"] = scale
    assert client.post("/api/sources", json=body).status_code == 200


def _seed_logs(box: dict[str, Any], index: str, docs: list[dict[str, Any]]) -> None:
    for doc in docs:
        _state(box).es.add_log(index, doc)


def _seed_cases(box: dict[str, Any], cases: list[Case]) -> None:
    async def run() -> None:
        for case in cases:
            await _state(box).cases.save(case)

    _client(box).portal.call(run)


def _summary(client: TestClient, **params: Any) -> dict[str, Any]:
    r = client.get("/api/rules/summary", params={"rule": RULE, **params})
    assert r.status_code == 200, r.text
    body = r.json()
    RuleSummary.model_validate(body)
    return body


def _series_total(alerts: dict[str, Any]) -> dict[str, int]:
    totals = {lv: 0 for lv in ("critical", "high", "medium", "low", "info")}
    for point in alerts["series"]["points"]:
        for lv in totals:
            totals[lv] += point[lv]
    return totals


# --------------------------------------------------------------------------- #
# 1. Every section, one exact source
# --------------------------------------------------------------------------- #
def test_every_section_reads_the_rule(box) -> None:
    client = _client(box)
    _seed_logs(box, INDEX_WZ, [
        _doc(severity=13, ip="198.51.100.23", hours_ago=1),
        _doc(severity=13, ip="198.51.100.23", hours_ago=5),
        _doc(severity=8, ip="198.51.100.23", host="db01", hours_ago=20),
        _doc(severity=4, ip="203.0.113.7", user="admin", hours_ago=40),
        _doc(severity=None, ip="203.0.113.7", hours_ago=60),
        _doc(module="web_scan", severity=13, hours_ago=2),        # another rule
        _doc(severity=13, hours_ago=24 * 5),                      # outside 3 days
    ])
    _add_source(client, "wz", INDEX_WZ, scale=15)
    _seed_cases(box, _cases())

    body = _summary(client)
    assert body["rule"] == RULE
    assert body["window"]["label"] == "Last 3 days"
    alerts = body["alerts"]
    assert alerts["status"] == "ok" and alerts["reason"] is None
    assert alerts["count"] == 5 and alerts["count_relation"] == "eq"
    assert alerts["sources"] == [{"id": "wz", "name": alerts["sources"][0]["name"], "exact": True}]
    assert alerts["series"]["bucket"] == "12h"
    assert alerts["series"]["levels"] == ["critical", "high", "medium", "low", "info"]
    assert 6 <= len(alerts["series"]["points"]) <= 7
    # 13/15 Critical, 8/15 High, 4/15 Medium, a missing value Info.
    assert _series_total(alerts) == {"critical": 2, "high": 1, "medium": 1, "low": 0, "info": 1}
    first = datetime.fromisoformat(alerts["first_seen"])
    last = datetime.fromisoformat(alerts["last_seen"])
    assert timedelta(hours=59) < datetime.now(UTC) - first < timedelta(hours=61)
    assert timedelta(minutes=50) < datetime.now(UTC) - last < timedelta(minutes=70)

    ips = body["top_source_ips"]
    assert ips["status"] == "ok" and ips["exact"] is True
    assert ips["rows"] == [{"value": "198.51.100.23", "kind": None, "count": 3},
                           {"value": "203.0.113.7", "kind": None, "count": 2}]
    targets = body["top_targets"]
    assert targets["exact"] is True
    assert {(r["value"], r["kind"], r["count"]) for r in targets["rows"]} == {
        ("web01", "host", 4), ("db01", "host", 1), ("root", "user", 4), ("admin", "user", 1),
    }
    assert targets["rows"][0]["count"] == 4

    cases = body["cases"]
    assert cases["status"] == "ok"
    assert cases["count"] == 4 and cases["open_now"] == 2
    # Policy closes are never graded: c-003 is waiting, not benign.
    assert cases["outcomes"] == {"analyst_tp": 1, "analyst_fp": 1, "analyst_ungraded": 2}
    assert [c["case_id"] for c in cases["latest"]] == ["c-001", "c-002", "c-003", "c-004"]
    assert cases["latest"][0] == {"case_id": "c-001", "case_number": "CASE-000001", "title": "Case c-001",
                                  "status": "escalated", "verdict": "TRUE_POSITIVE"}

    assert body["definition"] == {"status": "ok", "reason": None, "kind": "source", "suite_rule": None}
    assert body["analyst_policy"] == {"status": "ok", "reason": None, "policy": None}
    assert body["tuning"]["status"] == "ok"


def test_the_case_count_is_the_cases_list_filtered_by_the_rule(box) -> None:
    client = _client(box)
    _seed_cases(box, _cases())
    listed = client.get("/api/cases", params={"rule": RULE, "limit": 100}).json()
    assert _summary(client)["cases"]["count"] == listed["total"] == 4


def test_the_case_section_is_the_same_on_sqlite(tmp_path) -> None:
    secrets = Secrets(_env_file=None, es_store_enabled=False, redis_url="", anthropic_api_key=None,
                      openai_api_key=None, state_backend="sqlite",
                      state_db_url=f"sqlite+aiosqlite:///{tmp_path / 'state.db'}")
    holder: dict[str, Any] = {}
    with TestClient(_app(holder, secrets=secrets)) as client:
        holder["client"] = client
        _seed_cases(holder, _cases())
        cases = _summary(client)["cases"]
        listed = client.get("/api/cases", params={"rule": RULE, "limit": 100}).json()
        assert cases["count"] == listed["total"] == 4 and cases["open_now"] == 2
        assert cases["outcomes"] == {"analyst_tp": 1, "analyst_fp": 1, "analyst_ungraded": 2}
        assert [c["case_id"] for c in cases["latest"]] == ["c-001", "c-002", "c-003", "c-004"]


def test_at_most_five_newest_cases_are_listed(box) -> None:
    _seed_cases(box, [_case(f"c-{i:03d}", hours_ago=i + 1, rule_ids=[RULE]) for i in range(8)])
    latest = _summary(_client(box))["cases"]["latest"]
    assert [c["case_id"] for c in latest] == ["c-000", "c-001", "c-002", "c-003", "c-004"]


# --------------------------------------------------------------------------- #
# 2. Levels across scales, exact versus sampled
# --------------------------------------------------------------------------- #
def test_three_scales_merge_level_by_level(box) -> None:
    client = _client(box)
    _seed_logs(box, INDEX_WZ, [_doc(severity=s, hours_ago=2) for s in (13, 8, 4, 2, 1)])   # 0 to 15
    _seed_logs(box, INDEX_QR, [_doc(severity=s, hours_ago=3) for s in (8, 5, 3, 1, 0)])    # 0 to 10
    _seed_logs(box, INDEX_ECS, [_doc(severity=s, hours_ago=4) for s in (80, 50, 30, 10, 5)])
    _add_source(client, "wz", INDEX_WZ, scale=15)
    _add_source(client, "qr", INDEX_QR, scale=10)
    _add_source(client, "ecs", INDEX_ECS)
    alerts = _summary(client)["alerts"]
    assert alerts["count"] == 15 and alerts["count_relation"] == "eq"
    assert _series_total(alerts) == {lv: 3 for lv in ("critical", "high", "medium", "low", "info")}
    assert sorted(s["id"] for s in alerts["sources"]) == ["ecs", "qr", "wz"]


def test_a_push_ring_alone_is_unsupported_and_said_so(box) -> None:
    client = _client(box)
    assert client.post("/api/sources", json={"id": "wh", "source_type": "webhook"}).status_code == 200
    now = datetime.now(UTC).isoformat()
    alerts = [{"src_ip": "5.5.5.5", "user": "eve", "severity": "high", "@timestamp": now,
               "signature": RULE if i < 3 else "port_scan", "id": f"evt-{i}"} for i in range(5)]
    assert client.post("/api/ingest/wh", json=alerts).status_code == 200
    body = _summary(client)
    section = body["alerts"]
    assert section["status"] == "unsupported"
    # The ring is not a newest-200 sample: it is the events the source still holds.
    assert section["reason"] == "Live-tail sources count only the events they still hold."
    assert section["count"] == 3 and section["count_relation"] == "gte"
    assert section["sources"] == [{"id": "wh", "name": section["sources"][0]["name"], "exact": False}]
    assert sum(_series_total(section).values()) == 3
    # Its newest match is known; its first is not (older events left the ring).
    assert section["last_seen"] is not None and section["first_seen"] is None
    assert body["top_source_ips"]["status"] == "unsupported"
    assert body["top_source_ips"]["reason"] == "Live-tail sources count only the events they still hold."
    assert body["top_source_ips"]["rows"] == [{"value": "5.5.5.5", "kind": None, "count": 3}]
    assert body["top_source_ips"]["exact"] is False


def test_an_exact_source_beside_a_ring_is_ok_but_at_least(box) -> None:
    client = _client(box)
    _seed_logs(box, INDEX_ECS, [_doc(severity=80, ip="1.1.1.1") for _ in range(2)])
    _add_source(client, "ecs", INDEX_ECS)
    assert client.post("/api/sources", json={"id": "wh", "source_type": "webhook"}).status_code == 200
    now = datetime.now(UTC).isoformat()
    assert client.post("/api/ingest/wh", json=[
        {"src_ip": "1.1.1.1", "severity": "high", "@timestamp": now, "signature": RULE, "id": "e1"},
    ]).status_code == 200
    section = _summary(client)["alerts"]
    assert section["status"] == "ok" and section["count"] == 3 and section["count_relation"] == "gte"
    assert section["reason"] == "Live-tail sources count only the events they still hold."
    assert {s["id"]: s["exact"] for s in section["sources"]} == {"ecs": True, "wh": False}
    # The ring's first match is unknown, so the rule's first event is not claimed.
    assert section["first_seen"] is None and section["last_seen"] is not None
    ips = _summary(client)["top_source_ips"]
    assert ips["rows"] == [{"value": "1.1.1.1", "kind": None, "count": 3}] and ips["exact"] is False


def test_a_failing_source_degrades_alone(box, monkeypatch) -> None:
    client = _client(box)
    _seed_logs(box, INDEX_ECS, [_doc(severity=80)])
    _seed_logs(box, INDEX_WZ, [_doc(severity=13)])
    _add_source(client, "ecs", INDEX_ECS)
    _add_source(client, "wz", INDEX_WZ, scale=15)
    es = _state(box).es
    original = es.search_logs

    async def flaky(index: str, body: dict[str, Any]) -> dict[str, Any]:
        if index == INDEX_WZ:
            raise RuntimeError("tls handshake failed")
        return await original(index, body)

    monkeypatch.setattr(es, "search_logs", flaky)
    section = _summary(client)["alerts"]
    assert section["status"] == "ok" and section["reason"] == "1 of 2 sources did not answer."
    assert section["count"] == 1 and section["count_relation"] == "gte"
    assert {s["id"]: s["exact"] for s in section["sources"]} == {"ecs": True, "wz": False}


def test_a_refused_rule_clause_falls_back_to_a_stated_sample(box, monkeypatch) -> None:
    """A cluster that refuses the native rule clause (a 400) is read once more without it
    and filtered here; a read that held every event is still exact."""
    import json as _json

    client = _client(box)
    _seed_logs(box, INDEX_ECS, [_doc(severity=80), _doc(severity=50), _doc(module="other", severity=80)])
    _add_source(client, "ecs", INDEX_ECS)
    es = _state(box).es
    original = es.search_logs

    class _Refused(Exception):
        status_code = 400

    async def refusing(index: str, body: dict[str, Any]) -> dict[str, Any]:
        if "minimum_should_match" in _json.dumps(body):
            raise _Refused("[prefix] query on a numeric field")
        return await original(index, body)

    monkeypatch.setattr(es, "search_logs", refusing)
    section = _summary(client)["alerts"]
    assert section["status"] == "ok" and section["count"] == 2 and section["count_relation"] == "eq"
    assert section["sources"][0]["exact"] is True
    assert _series_total(section) == {"critical": 1, "high": 1, "medium": 0, "low": 0, "info": 0}
    assert section["first_seen"] is not None and section["last_seen"] is not None


def test_a_refused_rule_clause_over_more_events_than_one_read_is_at_least(box, monkeypatch) -> None:
    """The fallback reads the newest 200 events of the window: when the window holds
    more, the count is "at least" what they held and the first event is not claimed."""
    import json as _json

    client = _client(box)
    _seed_logs(box, INDEX_ECS, [_doc(severity=80, hours_ago=1 + i / 100) for i in range(150)])
    _seed_logs(box, INDEX_ECS, [_doc(module="other", severity=80, hours_ago=0.5) for _ in range(100)])
    _add_source(client, "ecs", INDEX_ECS)
    es = _state(box).es
    original = es.search_logs

    class _Refused(Exception):
        status_code = 400

    async def refusing(index: str, body: dict[str, Any]) -> dict[str, Any]:
        if "minimum_should_match" in _json.dumps(body):
            raise _Refused("[prefix] query on a numeric field")
        return await original(index, body)

    monkeypatch.setattr(es, "search_logs", refusing)
    section = _summary(client)["alerts"]
    assert section["status"] == "unsupported" and section["count"] == 100
    assert section["count_relation"] == "gte" and section["sources"][0]["exact"] is False
    assert section["reason"] == "Counted from the newest 200 events of the source."
    assert section["first_seen"] is None and section["last_seen"] is not None


def test_an_exact_count_with_a_sampled_chart_says_only_the_chart_is_sampled(box, monkeypatch) -> None:
    """No composite aggregation: the chart and lists come from the newest 200 events,
    but the count is the source's exact total, so the source is exact (the meaning
    ``GET /api/logs`` gives the word) and no reason calls the count sampled."""
    from app.connectors.elastic import ElasticConnector

    async def no_composite(*_a: Any, **_k: Any) -> None:
        return None

    monkeypatch.setattr(ElasticConnector, "aggregate_composite", no_composite)
    client = _client(box)
    _seed_logs(box, INDEX_ECS, [_doc(severity=80, hours_ago=1 + i / 100) for i in range(300)])
    _add_source(client, "ecs", INDEX_ECS)
    body = _summary(client)
    alerts = body["alerts"]
    assert alerts["status"] == "unsupported"
    assert alerts["count"] == 300 and alerts["count_relation"] == "eq"
    assert alerts["sources"][0]["exact"] is True
    assert alerts["reason"] == "The count is exact. The chart and top lists use the newest 200 events of the source."
    assert sum(_series_total(alerts).values()) == 200
    # The first and last match were read natively, so they are stated.
    assert alerts["first_seen"] is not None and alerts["last_seen"] is not None
    ips = body["top_source_ips"]
    assert ips["exact"] is False and ips["reason"] == "The top lists use the newest 200 events of the source."
    # The Logs page counts the same events for the same window.
    window = body["window"]
    logs = client.get("/api/logs", params={"rule": RULE, "from": window["from"], "to": window["to"],
                                           "limit": 50}).json()
    assert logs["sources"][0]["exact"] is True and logs["matched"] == {"count": 300, "relation": "eq"}


def _capped_composite(monkeypatch) -> None:
    """A composite read that stops after 20 combinations (the 10,000 cap, made small)."""
    from app.connectors.elastic import ElasticConnector

    original = ElasticConnector.aggregate_composite

    async def capped(self, prefs, query, fields, **kw):
        kw.update(page_size=5, max_buckets=20)
        return await original(self, prefs, query, fields, **kw)

    monkeypatch.setattr(ElasticConnector, "aggregate_composite", capped)


def test_continuous_severities_are_counted_per_level_natively(box, monkeypatch) -> None:
    """More distinct raw values than one composite read pages: the series is counted
    per named level instead, exact whatever the values (one bucket per time bucket)."""
    import random

    from app.engine.severity_levels import level_of_raw

    _capped_composite(monkeypatch)
    client = _client(box)
    rng = random.Random(5)
    values = [round(rng.uniform(0, 100), 5) for _ in range(60)] + [None]
    _seed_logs(box, INDEX_ECS, [_doc(severity=v, hours_ago=1 + i / 10) for i, v in enumerate(values)])
    _add_source(client, "ecs", INDEX_ECS)
    alerts = _summary(client)["alerts"]
    assert alerts["status"] == "ok" and alerts["reason"] is None
    assert alerts["count"] == len(values) and alerts["count_relation"] == "eq"
    expected = {lv: 0 for lv in ("critical", "high", "medium", "low", "info")}
    for v in values:
        expected[level_of_raw(v, 100)] += 1
    assert _series_total(alerts) == expected


def test_a_capped_chart_of_text_severities_says_it_shows_at_least_these(box, monkeypatch) -> None:
    """Severity values stored as text cannot be compared as numbers, so a chart past the
    bucket cap stays a lower bound, and the reason says so in its own words."""
    _capped_composite(monkeypatch)
    client = _client(box)
    _seed_logs(box, INDEX_ECS, [_doc(severity=f"{50 + i / 10:.1f}", hours_ago=1 + i / 10) for i in range(40)])
    _add_source(client, "ecs", INDEX_ECS)
    alerts = _summary(client)["alerts"]
    assert alerts["status"] == "ok" and alerts["count"] == 40 and alerts["count_relation"] == "eq"
    assert alerts["sources"][0]["exact"] is True
    assert alerts["reason"] == ("The chart for the source shows at least these alerts: there are too many "
                                "distinct severity values to count in one read.")
    assert 0 < sum(_series_total(alerts).values()) < 40

def test_no_browsable_source_leaves_the_other_sections_working(box) -> None:
    _seed_cases(box, _cases())
    body = _summary(_client(box))
    assert body["alerts"]["status"] == "unsupported"
    assert body["alerts"]["reason"] == "No log source can be browsed."
    assert body["alerts"]["count"] is None
    assert body["cases"]["status"] == "ok" and body["cases"]["count"] == 4


def test_source_id_restricts_the_alert_sections(box) -> None:
    client = _client(box)
    _seed_logs(box, INDEX_ECS, [_doc(severity=80)])
    _seed_logs(box, INDEX_WZ, [_doc(severity=13), _doc(severity=13)])
    _add_source(client, "ecs", INDEX_ECS)
    _add_source(client, "wz", INDEX_WZ, scale=15)
    scoped = _summary(client, source_id="wz")["alerts"]
    assert scoped["count"] == 2 and [s["id"] for s in scoped["sources"]] == ["wz"]
    missing = _summary(client, source_id="nope")["alerts"]
    assert missing["status"] == "unsupported" and missing["reason"] == "That source is not available for browsing."


def test_an_all_time_window_starts_at_the_first_event(box) -> None:
    """The figures of an all-time window are counted from the epoch, and ``window``
    says so: a Logs link built from ``from``/``to`` reads every event the summary
    counted (without ``from`` Logs would read the last 24 hours)."""
    client = _client(box)
    _seed_logs(box, INDEX_ECS, [_doc(severity=80, hours_ago=24 * 20), _doc(severity=50, hours_ago=1)])
    _add_source(client, "ecs", INDEX_ECS)
    body = _summary(client, window="all")
    assert body["window"]["label"].startswith("All time")
    assert body["window"]["from"] == "1970-01-01T00:00:00+00:00"
    alerts = body["alerts"]
    assert alerts["count"] == 2 and alerts["series"]["bucket"] == "7d"
    assert _series_total(alerts) == {"critical": 1, "high": 1, "medium": 0, "low": 0, "info": 0}
    logs = client.get("/api/logs", params={"rule": RULE, "from": body["window"]["from"],
                                           "to": body["window"]["to"], "limit": 50}).json()
    assert logs["count"] == 2 and logs["matched"] == {"count": alerts["count"], "relation": "eq"}


# --------------------------------------------------------------------------- #
# Merged top lists and a sampled Demo ring
# --------------------------------------------------------------------------- #
def _fig(sid: str, values: dict[str, int], *, complete: bool, kind: str = "ip",
         error_bound: int | None = 0) -> Any:
    """A native top list: ``complete`` = it listed every value it has (no remainder);
    ``error_bound`` = the store's ``doc_count_error_upper_bound`` (``None``: unreported)."""
    fig = routes_rule_summary._Figures(routes_rule_summary._Plan(sid, sid.upper(), "pull", 100.0))
    fig.tops[kind] = Counter(values)
    fig.tops_complete[kind] = complete
    fig.tops_ranked_exact[kind] = routes_rule_summary._ranked_exact(0 if complete else 1, error_bound)
    return fig


def test_a_merged_top_list_is_not_exact_when_a_left_off_value_may_outrank_it() -> None:
    """Source A lists its top 10 (100 down to 91) and holds more values (X = 90 among
    them); source B lists every value it has, X = 50 among them. X's true count is 140,
    more than the tenth row's 91, so the merged list cannot be called exact."""
    a = _fig("a", {f"10.0.0.{i}": 101 - i for i in range(1, 11)}, complete=False)
    b = _fig("b", {"X": 50, **{f"10.0.0.{i}": 1 for i in range(1, 10)}}, complete=True)
    rows, exact = routes_rule_summary._merge_top([a, b], ("ip",))
    assert len(rows) == 10 and "X" not in {r.value for r in rows}
    assert exact is False


def test_a_merged_top_list_stays_exact_when_nothing_left_off_can_outrank_it() -> None:
    # One incomplete source: its tenth count is its floor, so nothing it left off is bigger.
    single = _fig("a", {f"10.0.0.{i}": 101 - i for i in range(1, 11)}, complete=False)
    assert routes_rule_summary._merge_top([single], ("ip",))[1] is True
    # Two sources listing the same values: every listed count is whole, and what both
    # left off is at most the sum of their floors, the tenth merged count.
    same = {f"10.0.0.{i}": 101 - i for i in range(1, 11)}
    assert routes_rule_summary._merge_top([_fig("a", same, complete=False),
                                           _fig("b", same, complete=False)], ("ip",))[1] is True
    # Fewer than 10 rows and an incomplete source: something unseen may belong in them.
    short = _fig("a", {"1.1.1.1": 5}, complete=False)
    assert routes_rule_summary._merge_top([short], ("ip",))[1] is False
    # An incomplete source that listed nothing bounds nothing.
    empty = _fig("a", {}, complete=False)
    whole = _fig("b", {"1.1.1.1": 5}, complete=True)
    assert routes_rule_summary._merge_top([empty, whole], ("ip",))[1] is False
    # Every source complete: exact.
    assert routes_rule_summary._merge_top([whole, _fig("c", {"2.2.2.2": 1}, complete=True)],
                                          ("ip",))[1] is True


def test_a_top_list_a_multi_shard_read_approximated_is_never_exact() -> None:
    """Over more than one shard a ``terms`` list with a remainder is approximate: a
    value outside one shard's own top list misses that shard's share, so a listed count
    can be low and a value left off can outrank the tenth row. The store reports that as
    ``doc_count_error_upper_bound``; only a bound of 0 lets a floor stand for what a
    source left off, and an unreported bound proves nothing."""
    top10 = {f"10.0.0.{i}": 101 - i for i in range(1, 11)}
    # One incomplete source whose list the store approximated: not exact.
    rows, exact = routes_rule_summary._merge_top([_fig("a", top10, complete=False, error_bound=7)], ("ip",))
    assert len(rows) == 10 and exact is False
    # The same list with no reported bound: not exact either.
    assert routes_rule_summary._merge_top([_fig("a", top10, complete=False, error_bound=None)],
                                          ("ip",))[1] is False
    # A bound of -1 ("not computed") proves nothing.
    assert routes_rule_summary._merge_top([_fig("a", top10, complete=False, error_bound=-1)],
                                          ("ip",))[1] is False
    # A list with no remainder is exact whatever its bound.
    assert routes_rule_summary._merge_top([_fig("a", top10, complete=True, error_bound=7)], ("ip",))[1] is True
    # One approximate source makes a merged list inexact even beside an exact one.
    assert routes_rule_summary._merge_top([_fig("a", top10, complete=False, error_bound=0),
                                           _fig("b", top10, complete=False, error_bound=3)],
                                          ("ip",))[1] is False
    assert routes_rule_summary._ranked_exact(0, None) is True
    assert routes_rule_summary._ranked_exact(5, 0) is True
    assert routes_rule_summary._ranked_exact(5, 7) is False
    assert routes_rule_summary._ranked_exact(5, None) is False


def test_the_connector_reports_each_top_lists_count_error_bound() -> None:
    """``ElasticConnector.aggregate`` keeps each group's ``doc_count_error_upper_bound``
    (``RankedAggregateResult.error_bound``): the reported value when the store sends it,
    0 for a store that reports neither figure (the offline fake answers from one shard,
    the assumption the remainder already makes), and nothing for a store that reports a
    remainder without a bound."""
    from app.connectors.base import QueryRendering
    from app.connectors.elastic import ElasticConnector, RankedAggregateResult

    conn = ElasticConnector(InMemoryESClient(), config={}, connector_id="ecs")
    resp = {
        "hits": {"total": {"value": 120, "relation": "eq"}},
        "aggregations": {
            "g_ip": {"doc_count_error_upper_bound": 7, "sum_other_doc_count": 30,
                     "buckets": [{"key": "198.51.100.23", "doc_count": 90}]},
            "g_host": {"buckets": [{"key": "web01", "doc_count": 120}]},
            "g_user": {"sum_other_doc_count": 20, "buckets": [{"key": "root", "doc_count": 100}]},
        },
    }
    result = conn._aggregate_result(resp, ["ip", "host", "user"], interval=None,
                                    rendering=QueryRendering(query="", language="kuery"))
    assert isinstance(result, RankedAggregateResult)
    assert result.error_bound == {"ip": 7, "host": 0}
    assert result.other == {"ip": 30, "host": 0, "user": 20}


def test_an_approximate_top_list_from_the_store_is_stated_and_not_exact(box, monkeypatch) -> None:
    """A store that reports a count error for the source IP list (a read over more than
    one shard) keeps the alert count exact but calls the IP list approximate, and says
    why; the target lists, which listed every value, stay exact."""
    client = _client(box)
    docs = [_doc(ip=f"198.51.100.{i}", hours_ago=1 + i / 100) for i in range(12) for _ in range(i + 1)]
    _seed_logs(box, INDEX_ECS, docs)
    _add_source(client, "ecs", INDEX_ECS)
    es = _state(box).es
    original = es.search_logs

    async def sharded(index: str, body: dict[str, Any]) -> dict[str, Any]:
        resp = await original(index, body)
        terms = (resp.get("aggregations") or {}).get("g_ip")
        if isinstance(terms, dict) and "buckets" in terms:
            listed = sum(int(b["doc_count"]) for b in terms["buckets"])
            terms["sum_other_doc_count"] = len(docs) - listed
            terms["doc_count_error_upper_bound"] = 7
        return resp

    monkeypatch.setattr(es, "search_logs", sharded)
    body = _summary(client)
    assert body["alerts"]["count"] == len(docs) and body["alerts"]["count_relation"] == "eq"
    ips = body["top_source_ips"]
    assert ips["status"] == "ok" and len(ips["rows"]) == 10 and ips["exact"] is False
    assert ips["reason"] == ("The log store approximates top values across its shards, so a count may be "
                             "low or a busier value missing.")
    targets = body["top_targets"]
    assert targets["exact"] is True and targets["reason"] is None


def test_a_row_the_rule_identity_rejects_leaves_the_sheet_and_logs_at_least(box, monkeypatch) -> None:
    """The native clause let in a row whose rule is not this one (a token match on an
    analysed field without an exact sub-field, say). Logs drops the row and reports the
    source as not exact; the sheet reads the same rows and says the same, never "eq"
    and "Open all N in Logs" while Logs says "at least"."""
    from app.connectors.elastic import ElasticConnector
    from app.models import RawEvent
    from app.utils import now_utc, to_millis

    client = _client(box)
    _seed_logs(box, INDEX_ECS, [_doc(severity=80, hours_ago=1 + i / 10) for i in range(5)])
    _add_source(client, "ecs", INDEX_ECS)
    original = ElasticConnector.search

    async def leaky(self, prefs, query):
        result = await original(self, prefs, query)
        if getattr(query, "rule_any", None):
            stray = RawEvent(id="stray", rule="ssh_fail_retry", timestamp_millis=to_millis(now_utc()) - 60_000,
                             source={"event": {"module": "ssh_fail_retry"}})
            result.events.insert(0, stray)
        return result

    monkeypatch.setattr(ElasticConnector, "search", leaky)
    body = _summary(client)
    alerts = body["alerts"]
    window = body["window"]
    logs = client.get("/api/logs", params={"rule": RULE, "from": window["from"], "to": window["to"],
                                           "limit": 50}).json()
    assert logs["sources"][0]["exact"] is False and logs["matched"] == {"count": 5, "relation": "gte"}
    assert alerts["sources"][0]["exact"] is False
    assert alerts["count"] == 5 and alerts["count_relation"] == "gte"
    assert alerts["reason"] == "Counted from the newest 200 events of the source."
    assert body["top_source_ips"]["exact"] is False
    # Without the stray row both are exact again.
    monkeypatch.setattr(ElasticConnector, "search", original)
    assert _summary(client)["alerts"]["sources"][0]["exact"] is True


def test_a_demo_ring_larger_than_one_read_states_its_first_event_from_its_own_read() -> None:
    """The newest 200 matches of a Demo ring give an exact count (the ring's total) and
    the last event; the first event is read on its own, oldest first, never taken from
    the oldest of the 200."""
    from types import SimpleNamespace

    from app.connectors.base import SearchResult
    from app.models import RawEvent
    from app.utils import now_utc, to_millis

    now = to_millis(now_utc())
    events = [RawEvent(id=f"d{i}", rule=RULE, severity=80.0, timestamp_millis=now - i * 60_000)
              for i in range(381)]

    class _Demo:
        async def search(self, prefs: Any, query: Any) -> SearchResult:
            hits = [e for e in events if query.rule in (e.rule, e.rule_name)]
            hits.sort(key=lambda e: e.timestamp_millis, reverse=bool(query.sort_desc))
            return SearchResult(events=hits[: query.size], total=len(hits))

    state = SimpleNamespace(prefs=None, demo_source_connector=lambda _sid: _Demo())
    plan = routes_rule_summary._Plan("demo-1", "Demo", "demo", 100.0)

    async def run() -> Any:
        return await routes_rule_summary._read_sample(state, plan, RULE, "now-1d", "now", None, None)

    import asyncio as _asyncio

    loop = _asyncio.new_event_loop()
    try:
        fig = loop.run_until_complete(run())
    finally:
        loop.close()
    assert fig.count == 381 and fig.count_exact is True and fig.limit == "sample"
    assert fig.last_ms == now and fig.last_exact is True
    assert fig.first_ms == now - 380 * 60_000 and fig.first_exact is True


def test_the_bucket_ladder_keeps_a_series_short() -> None:
    assert pick_bucket(3 * 86_400) == ("12h", 43_200)
    assert pick_bucket(86_400) == ("3h", 10_800)
    assert pick_bucket(7 * 86_400) == ("1d", 86_400)
    assert pick_bucket(30 * 86_400) == ("7d", 604_800)
    assert pick_bucket(3_600) == ("15m", 900)
    assert pick_bucket(0) == ("1h", 3600) and pick_bucket(None) == ("1h", 3600)
    assert pick_bucket(1e12)[0] == "365d"


# --------------------------------------------------------------------------- #
# 3. Definition, analyst policy, tuning
# --------------------------------------------------------------------------- #
def test_a_suite_rule_and_a_live_policy_are_described(box) -> None:
    state = _state(box)

    async def configure() -> None:
        await state.update_prefs(state.prefs.model_copy(update={
            "rule_catalog": [RuleDefinition(name=RULE, description="SSH sign-in failures",
                                            match=RuleMatch(field="event.module", op="equals", value=RULE),
                                            mitre=["T1110"], priority=40)],
            "analyst_rule_policies": [
                AnalystRulePolicy(rule_id=RULE, reason="Lab scanner", source_id="lab", id="arp-scoped"),
                AnalystRulePolicy(rule_id=RULE, reason="Known noisy", id="arp-all"),
                AnalystRulePolicy(rule_id=RULE, reason="Old", enabled=False, id="arp-off"),
            ],
        }))

    _client(box).portal.call(configure)
    body = _summary(_client(box))
    assert body["definition"] == {"status": "ok", "reason": None, "kind": "suite", "suite_rule": {
        "name": RULE, "enabled": True, "description": "SSH sign-in failures", "mitre": ["T1110"],
        "priority": 40,
    }}
    policy = body["analyst_policy"]["policy"]
    assert policy["id"] == "arp-all" and policy["reason"] == "Known noisy" and policy["live"] is True


def test_tuning_reads_the_rule_statistics_and_its_last_change(box) -> None:
    graded = [
        _case(f"t-{i:03d}", hours_ago=3, rule_ids=[RULE], status=CaseStatus.CLOSED,
              decision_by=DecisionBy.ANALYST, verdict=Verdict.FALSE_POSITIVE,
              feedback=_feedback("false_positive"))
        for i in range(4)
    ]
    _seed_cases(box, graded)
    state = _state(box)

    async def ledger() -> None:
        await state.tuning_store.add(TuningRecord(
            rule_id=RULE, target="correlation_n", before=1, after=2, fp_rate=0.9, samples=12,
            rationale="noisy",
        ))

    _client(box).portal.call(ledger)
    tuning = _summary(_client(box))["tuning"]
    assert tuning["status"] == "ok"
    assert tuning["samples"] == 4
    assert tuning["wilson_lower_bound"] is not None and 0 < tuning["wilson_lower_bound"] <= 1
    assert tuning["last_tuned"]


def test_a_rolled_back_change_is_not_the_last_tuning(box) -> None:
    state = _state(box)

    async def ledger() -> None:
        await state.tuning_store.add(TuningRecord(
            rule_id=RULE, target="correlation_n", before=1, after=2, applied_at="2026-10-20T10:00:00+00:00",
        ))
        await state.tuning_store.add(TuningRecord(
            rule_id=RULE, target="correlation_n", before=2, after=3, applied_at="2026-10-24T10:00:00+00:00",
            rolled_back=True, rolled_back_at="2026-10-24T11:00:00+00:00",
        ))

    _client(box).portal.call(ledger)
    assert _summary(_client(box))["tuning"]["last_tuned"] == "2026-10-20T10:00:00+00:00"


def _noisy_cases(*, with_unproven_tp: bool) -> list[Case]:
    """31 analyst-graded cases of the rule: false positives clearing the tuner's bar,
    and (optionally) one confirmed true positive with no recorded member count, which
    shadow evaluation must treat as hidden by any raise."""
    cases = [
        _case(f"n-{i:03d}", hours_ago=3, rule_ids=[RULE], status=CaseStatus.CLOSED,
              decision_by=DecisionBy.ANALYST, verdict=Verdict.FALSE_POSITIVE,
              feedback=_feedback("false_positive"))
        for i in range(31)
    ]
    if with_unproven_tp:
        cases.append(_case("n-tp", hours_ago=3, rule_ids=[RULE], status=CaseStatus.CLOSED,
                           decision_by=DecisionBy.ANALYST, verdict=Verdict.TRUE_POSITIVE,
                           feedback=_feedback("true_positive")))
    return cases


@pytest.mark.parametrize("with_unproven_tp", [False, True])
def test_the_proposed_change_carries_the_tuning_pages_gates(box, with_unproven_tp) -> None:
    """The sheet shows the proposal the Tuning page shows for the rule, gates included:
    a raise that would hide a confirmed true positive is ``shadow_blocked``, and a
    proposal the policy does not auto-apply ``requires_approval``."""
    client = _client(box)
    _seed_cases(box, _noisy_cases(with_unproven_tp=with_unproven_tp))
    proposed = _summary(client)["tuning"]["proposed_change"]
    page = client.get("/api/tuning/recommendations").json()
    expected = next(r for r in page["recommendations"] if r["rule_id"] == RULE)
    assert proposed is not None
    assert {k: v for k, v in proposed.items() if k != "requires_approval"} == expected
    assert proposed["shadow_blocked"] is with_unproven_tp
    assert proposed["requires_approval"] is True and proposed["auto_apply"] is False


def test_the_tuning_view_is_reused_until_the_ledger_changes(box, monkeypatch) -> None:
    from app.api import routes_tuning

    client = _client(box)
    _seed_cases(box, _noisy_cases(with_unproven_tp=False))
    reads = {"n": 0}
    original = routes_tuning._window_cases

    async def counting(state: Any) -> Any:
        reads["n"] += 1
        return await original(state)

    monkeypatch.setattr(routes_tuning, "_window_cases", counting)
    first = _summary(client)["tuning"]
    second = _summary(client)["tuning"]
    assert reads["n"] == 1 and first == second
    state = _state(box)

    async def ledger() -> None:
        await state.tuning_store.add(TuningRecord(rule_id="other", target="correlation_n", before=1, after=2))

    client.portal.call(ledger)
    _summary(client)
    assert reads["n"] == 2


# --------------------------------------------------------------------------- #
# The newest cases and a cancelled case read
# --------------------------------------------------------------------------- #
class _ScanStore:
    """A case store that pages ``rows`` two at a time, newest first when asked."""

    def __init__(self, rows: list[dict[str, Any]], *, ordered: bool) -> None:
        self.rows = rows
        self.ordered = ordered
        self.pages = 0
        self.closed: list[Any] = []

    async def scan_page(self, *, limit: int, cursor: Any = None, raw: bool = False, statuses: Any = None,
                        newest_first: bool = False, fields: Any = None, created_from: Any = None,
                        created_to: Any = None) -> tuple[list[Any], Any, int, str]:
        rows = sorted(self.rows, key=lambda r: (r["created_at"], r["case_id"]), reverse=True) \
            if (newest_first and self.ordered) else list(self.rows)
        start = int(cursor or 0)
        self.pages += 1
        page = rows[start:start + 2]
        nxt = start + 2 if start + 2 < len(rows) else None
        return page, nxt, len(rows), "snapshot"

    async def close_scan_cursor(self, cursor: Any) -> None:
        self.closed.append(cursor)


def _rows(n: int) -> list[dict[str, Any]]:
    base = datetime(2026, 10, 1, tzinfo=UTC)
    return [{"case_id": f"c-{i:03d}", "case_number": f"CASE-{i:06d}", "title": f"Case {i}",
             "status": "open", "verdict": None, "created_at": (base + timedelta(hours=i)).isoformat(),
             "rule_ids": [RULE] if i % 3 == 0 else ["other"]} for i in range(n)]


@pytest.mark.parametrize("ordered", [True, False])
def test_the_newest_cases_stop_reading_once_nothing_older_can_enter(ordered) -> None:
    from types import SimpleNamespace

    from app.config import Preferences

    store = _ScanStore(_rows(60), ordered=ordered)
    state = SimpleNamespace(cases=store, execution_prefs=Preferences(rule_catalog=[]))
    import asyncio as _asyncio

    loop = _asyncio.new_event_loop()
    try:
        latest = loop.run_until_complete(routes_rule_summary._newest_cases(state, RULE, 5))
    finally:
        loop.close()
    assert [r.case_id for r in latest] == ["c-057", "c-054", "c-051", "c-048", "c-045"]
    assert latest[0].case_number == "CASE-000057" and latest[0].status == "open"
    if ordered:
        assert store.pages < 30 and store.closed  # stopped early, snapshot released
    else:
        assert store.pages == 30  # no order to rely on: every page is read


def test_a_cancelled_cases_section_releases_its_snapshot() -> None:
    """The cases section runs under a time budget; a cancellation mid-scan releases the
    scan's read snapshot (a cluster caps open snapshots)."""
    import asyncio as _asyncio
    from types import SimpleNamespace

    from app.config import Preferences

    blocked = _asyncio.Event()

    class _Slow(_ScanStore):
        async def scan_page(self, *, limit: int, cursor: Any = None, **kw: Any):
            if cursor is None:
                return [_rows(1)[0]], {"pit": "p-9"}, 2, "snapshot"
            await blocked.wait()
            raise AssertionError("unreachable")

    store = _Slow([], ordered=True)
    state = SimpleNamespace(cases=store, execution_prefs=Preferences(rule_catalog=[]))

    async def run() -> None:
        with pytest.raises(_asyncio.TimeoutError):
            await _asyncio.wait_for(routes_rule_summary._cases_section(state, RULE, scoped=False), timeout=0.05)

    loop = _asyncio.new_event_loop()
    try:
        loop.run_until_complete(run())
    finally:
        loop.close()
    assert store.closed == [{"pit": "p-9"}]


def test_a_case_scan_that_stopped_on_its_own_never_lists_a_partial_newest() -> None:
    """A page after the first fails: the scan ends early without raising, so a newer
    match may be missing. The newest list refuses rather than answer from part of it."""
    import asyncio as _asyncio
    from types import SimpleNamespace

    from app.config import Preferences

    class _Failing(_ScanStore):
        async def scan_page(self, **kw: Any):
            if kw.get("cursor") is not None:
                raise RuntimeError("shard unavailable")
            return await super().scan_page(**kw)

    store = _Failing(_rows(60), ordered=True)
    state = SimpleNamespace(cases=store, execution_prefs=Preferences(rule_catalog=[]))
    loop = _asyncio.new_event_loop()
    try:
        with pytest.raises(RuntimeError, match="stopped after 2 rows"):
            loop.run_until_complete(routes_rule_summary._newest_cases(state, RULE, 5))
    finally:
        loop.close()


def test_a_failed_newest_read_leaves_the_cases_section_unavailable(box, monkeypatch) -> None:
    async def broken(*_a: Any, **_k: Any) -> Any:
        raise RuntimeError("the case scan stopped after 200 rows: shard unavailable")

    monkeypatch.setattr(routes_rule_summary, "_newest_cases", broken)
    _seed_cases(box, _cases())
    cases = _summary(_client(box))["cases"]
    assert cases["status"] == "unavailable" and cases["count"] is None and cases["latest"] == []
    assert cases["reason"] == "The cases could not be read right now."


def _counted_cases_reads(monkeypatch, *, delay: float = 0.0, fail_first: bool = False,
                         bump_generation: bool = False) -> dict[str, int]:
    import asyncio as _asyncio

    reads = {"n": 0}
    original = routes_rule_summary._read_cases_section

    async def counting(state: Any, rule: str) -> Any:
        reads["n"] += 1
        if delay:
            await _asyncio.sleep(delay)
        if fail_first and reads["n"] == 1:
            raise RuntimeError("store unreachable")
        if bump_generation and reads["n"] == 1:
            state._demo_generation += 1  # Demo Mode switched while this read ran
        return await original(state, rule)

    monkeypatch.setattr(routes_rule_summary, "_read_cases_section", counting)
    return reads


def test_one_rules_cases_section_is_reused_for_a_while(box, monkeypatch) -> None:
    reads = _counted_cases_reads(monkeypatch)
    client = _client(box)
    _seed_cases(box, _cases())
    first = _summary(client)["cases"]
    assert first["count"] == 4 and _summary(client)["cases"] == first and reads["n"] == 1
    # Another rule is its own view.
    assert client.get("/api/rules/summary", params={"rule": "web_scan"}).json()["cases"]["count"] == 2
    assert reads["n"] == 2
    # Past its time it is read again.
    routes_rule_summary.invalidate_cases_views()
    monkeypatch.setattr(routes_rule_summary, "CASES_VIEW_TTL_S", 0.0)
    _summary(client)
    _summary(client)
    assert reads["n"] == 4


def test_concurrent_sheets_share_one_cases_read(box, monkeypatch) -> None:
    import asyncio as _asyncio

    reads = _counted_cases_reads(monkeypatch, delay=0.05)
    _seed_cases(box, _cases())
    state = _state(box)

    async def both() -> list[Any]:
        return list(await _asyncio.gather(
            routes_rule_summary._cases_section(state, RULE, scoped=False),
            routes_rule_summary._cases_section(state, RULE, scoped=False),
        ))

    first, second = _client(box).portal.call(both)
    assert reads["n"] == 1 and first == second and first.count == 4
    assert first is not second  # each caller gets its own copy


def test_a_failed_cases_read_is_never_reused(box, monkeypatch) -> None:
    client = _client(box)
    _seed_cases(box, _cases())
    reads = _counted_cases_reads(monkeypatch, fail_first=True)
    assert _summary(client)["cases"]["status"] == "unavailable"
    assert _summary(client)["cases"]["count"] == 4 and reads["n"] == 2


def test_a_cases_read_across_a_demo_switch_is_never_reused(box, monkeypatch) -> None:
    client = _client(box)
    _seed_cases(box, _cases())
    reads = _counted_cases_reads(monkeypatch, bump_generation=True)
    assert _summary(client)["cases"]["count"] == 4
    assert _summary(client)["cases"]["count"] == 4 and reads["n"] == 2


# --------------------------------------------------------------------------- #
# 4. Grants, scope, Demo, #6 and no audit
# --------------------------------------------------------------------------- #
def _rbac(secrets_kw: dict[str, Any], denies: dict[str, list[str]]):
    secrets = Secrets(_env_file=None, es_store_enabled=False, redis_url="", anthropic_api_key=None,
                      openai_api_key=None, auth_enabled=True, auth_jwt_secret="rule-summary-secret",
                      auth_seed_admin=True, **secrets_kw)
    holder: dict[str, Any] = {}
    return holder, TestClient(_app(holder, secrets=secrets, auth=True, denies=denies))


def _login_tier1(client: TestClient) -> None:
    assert client.post("/api/auth/login", json={"username": "Admin", "password": "Admin@123"}).status_code == 200
    assert client.post("/api/users", json={"username": "tier1", "password": "tier1-pass-1234",
                                           "role": "analyst_tier1"}).status_code == 200
    client.post("/api/auth/logout")
    assert client.post("/api/auth/login", json={"username": "tier1", "password": "tier1-pass-1234"}).status_code == 200


@pytest.mark.parametrize(("denies", "forbidden"), [
    ({"sources": ["read"]}, {"alerts", "top_source_ips", "top_targets"}),
    ({"cases": ["read"]}, {"cases"}),
    ({"rules": ["read"]}, {"definition", "analyst_policy"}),
    ({"automation": ["read"]}, {"tuning"}),
])
def test_each_section_checks_its_own_grant(denies, forbidden) -> None:
    holder, client = _rbac({}, denies)
    with client:
        assert client.get("/api/rules/summary", params={"rule": RULE}).status_code == 401
        _login_tier1(client)
        body = client.get("/api/rules/summary", params={"rule": RULE})
        assert body.status_code == 200, body.text
        data = body.json()
        sections = ("alerts", "top_source_ips", "top_targets", "cases", "definition", "tuning",
                    "analyst_policy")
        assert {name for name in sections if data[name]["status"] == "forbidden"} == forbidden
        # A denied section carries nothing.
        for name in forbidden:
            assert data[name].get("count") in (None,) and not data[name].get("rows")
        # A count it could not prove is never stated as exact (SPEC §4.6.4).
        if "alerts" in forbidden:
            assert data["alerts"]["count_relation"] == "gte" and data["alerts"]["sources"] == []


def test_alert_sections_that_fail_never_state_an_exact_count(box, monkeypatch) -> None:
    """An error in the alert sections degrades them alone, with no count and the
    relation ``gte`` (as every other unproven path), so a client that trusts ``eq``
    never reads a missing count as proven."""
    async def broken(*_a: Any, **_k: Any) -> Any:
        raise RuntimeError("store unreachable")

    monkeypatch.setattr(routes_rule_summary, "_alert_sections", broken)
    _seed_cases(box, _cases())
    body = _summary(_client(box))
    alerts = body["alerts"]
    assert alerts["status"] == "unavailable" and alerts["count"] is None
    assert alerts["count_relation"] == "gte" and alerts["sources"] == []
    assert alerts["reason"] == "The alert figures could not be read right now."
    for name in ("top_source_ips", "top_targets"):
        assert body[name]["status"] == "unavailable" and body[name]["exact"] is False
    assert body["cases"]["status"] == "ok"


def test_row_level_scope_hides_the_cases_section_only(box, monkeypatch) -> None:
    import app.engine.chat_starters as starters

    monkeypatch.setattr(starters, "object_scoped", lambda _state, _role: True)
    _seed_cases(box, _cases())
    body = _summary(_client(box))
    assert body["cases"] == {"status": "unsupported", "reason": "Hidden while row-level scope is on.",
                             "count": None, "open_now": None, "outcomes": None, "latest": []}
    assert body["definition"]["status"] == "ok"


def test_no_model_call_and_no_audit_row(box, monkeypatch) -> None:
    client = _client(box)
    _seed_logs(box, INDEX_ECS, [_doc(severity=80)])
    _add_source(client, "ecs", INDEX_ECS)
    _seed_cases(box, _cases())
    state = _state(box)

    async def boom(*_a: Any, **_k: Any) -> Any:  # pragma: no cover - must never run
        raise AssertionError("the rule summary must never call a model")

    monkeypatch.setattr(state.gateway, "complete", boom)

    async def audit_rows() -> int:
        return len(await state.control_audit.records(limit=500)) + len(await state.audit.records(limit=500))

    before = client.portal.call(audit_rows)
    body = _summary(client)
    assert body["alerts"]["count"] == 1 and body["cases"]["count"] == 4
    assert client.portal.call(audit_rows) == before


def test_demo_mode_reads_the_demo_sources_and_cases(box) -> None:
    client = _client(box)
    _seed_cases(box, _cases())
    state = _state(box)
    client.portal.call(lambda: state.enable_demo(mode="seeded", seed=7, history_days=2))
    try:
        rows = client.get("/api/logs", params={"limit": 200, "from": "now-3d"}).json()["logs"]
        rules = [row["rule"] for row in rows if row.get("rule")]
        assert rules, "the Demo sources hold rule-bearing events"
        rule = max(set(rules), key=rules.count)
        body = client.get("/api/rules/summary", params={"rule": rule}).json()
        demo_ids = {str(row["id"]) for row in state.demo_sources_overlay()}
        alerts = body["alerts"]
        assert alerts["count"] and alerts["count"] >= rules.count(rule) >= 1
        assert {s["id"] for s in alerts["sources"]} <= demo_ids
        # A Demo ring counts its matches exactly; its chart is a sample only when the
        # ring holds more matches than one read returns, and the reason then says the
        # count is exact.
        assert alerts["count_relation"] == "eq" and all(s["exact"] for s in alerts["sources"])
        if alerts["status"] == "ok":
            assert alerts["reason"] is None
        else:
            assert alerts["status"] == "unsupported"
            assert alerts["reason"].startswith("The count is exact. The chart and top lists use the newest 200")
        # The Logs page counts the same events (a Demo adapter is exact).
        window = body["window"]
        logs = client.get("/api/logs", params={"rule": rule, "from": window["from"], "to": window["to"],
                                               "limit": 5}).json()
        assert logs["matched"] == {"count": alerts["count"], "relation": "eq"}
        # The Demo case store answers: none of the real cases is visible.
        listed = client.get("/api/cases", params={"rule": rule, "limit": 100}).json()
        assert body["cases"]["count"] == listed["total"]
        assert not {c["case_id"] for c in body["cases"]["latest"]} & {c.case_id for c in _cases()}
    finally:
        client.portal.call(state.disable_demo)


# --------------------------------------------------------------------------- #
# 5. Input and copy
# --------------------------------------------------------------------------- #
def test_bad_input_is_refused(box) -> None:
    client = _client(box)
    # A missing parameter is FastAPI's validation error; a present, bad one is a 400
    # naming it (the ``GET /api/logs`` and ``GET /api/cases`` contract).
    assert client.get("/api/rules/summary").status_code == 422
    for rule in ("", "a\nb", "x" * 257, "a b"):
        r = client.get("/api/rules/summary", params={"rule": rule})
        assert r.status_code == 400, rule
        assert r.json()["detail"].startswith("rule "), rule
    assert client.get("/api/rules/summary", params={"rule": RULE, "window": "fortnight"}).status_code == 400
    assert client.get("/api/rules/summary", params={"rule": RULE, "window": "x" * 200}).status_code == 400


def test_window_labels_are_sentence_case_without_dashes(box) -> None:
    client = _client(box)
    assert _summary(client, window="now-24h")["window"]["label"] == "Last 24 hours"
    ranged = _summary(client, window="2026-10-22T00:00:00Z..2026-10-25T00:00:00Z")["window"]
    assert ranged["label"] == "22 Oct to 24 Oct 2026"
    assert ranged["from"].startswith("2026-10-22T00:00:00") and ranged["to"].startswith("2026-10-25T00:00:00")


def test_console_authored_strings_carry_no_dashes_or_playbook() -> None:
    source = Path(routes_rule_summary.__file__).read_text(encoding="utf-8")
    strings = re.findall(r'"([^"\n]*[A-Za-z][^"\n]*)"', source)
    reasons = [s for s in strings if s[:1].isupper() and " " in s]
    assert "Hidden while row-level scope is on." in reasons
    for text in reasons:
        assert "\u2014" not in text and "\u2013" not in text, text
        assert "playbook" not in text.lower(), text
