"""Round 14 (SPEC §4.4.3): the KPI strip bindings and the server fields they read.

``webui/src/soc/dashboard/kpi-bindings.ts`` is the one client copy of the spec's
binding table. This module READS that file (a small reader for its literal subset, so a
backend-only run catches a one-sided edit) and pins, for every cell:

* the endpoint it names is served and every dotted field it names exists in the
  response, with the type the honesty rules expect (a number, ``null``, or the server's
  dash string for a value; booleans for ``availableField`` and ``partialWhen`` flags;
  text for reasons), on the Demo dataset AND on a hand-built fixture whose figures are
  checked against direct counts of the store;
* the breakdown queries it sends are accepted and answer the groups and metrics it reads;
* ``GET /api/metrics/noise-reduction`` ``events_per_min`` (new in Round 14) is the
  ingested total over the minutes the counters covered inside the window, leaving out
  the hour the counters began in when that is inside the window (a backfilled burst);
* the investigation spend surfaces of ``kpi.cost_budget`` are the surfaces the
  investigation pipeline's router, investigator and formatter calls actually carry.
"""

from __future__ import annotations

import json
import math
import re
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient
from httpx import ASGITransport, AsyncClient

from app.api.deps import require_auth
from app.api.routes import router as main_router
from app.api.routes_metrics import _EVENTS_PER_MIN_MIN_SPAN_MINUTES, invalidate_breakdown_cache
from app.api.routes_metrics import router as metrics_router
from app.api.routes_standup import router as standup_router
from app.constants import (
    CASE_PIPELINE_USAGE_ROLES,
    OPEN_CASE_STATUSES,
    TERMINAL_CASE_STATUSES,
    CaseStatus,
    DecisionBy,
    EntityType,
    SourceSurface,
    Verdict,
)
from app.engine.analyst_outcomes import analyst_confirmed_outcome
from app.engine.noise_counters import empty_noise_delta
from app.engine.precedent import is_policy_closed
from app.engine.time_windows import align_whole_periods, resolve_window
from app.models import (
    Case,
    Entity,
    FeedbackEntry,
    MetricsBreakdown,
    StatusHistoryEntry,
    UsageDoc,
)
from app.rbac.policy import RESOURCES
from app.utils import now_utc, parse_es_timestamp, to_millis
from tests.conftest import make_log_event

UTC = timezone.utc
NOW = datetime.now(UTC).replace(microsecond=0)
BINDINGS_TS = (
    Path(__file__).resolve().parents[2] / "webui" / "src" / "soc" / "dashboard" / "kpi-bindings.ts"
)
_ACTIVE = frozenset(OPEN_CASE_STATUSES)
_TERMINAL = frozenset(TERMINAL_CASE_STATUSES)
BOARD_HOURS = 168  # the board window under test (last 7 days)
DASH = "—"    # the server's "no samples" sentinel some rollups print


@pytest.fixture(autouse=True)
def _fresh_breakdown_cache():
    """The breakdown endpoint shares answers for a few seconds; each test starts clean."""
    invalidate_breakdown_cache()
    yield
    invalidate_breakdown_cache()


# --------------------------------------------------------------------------- #
# A reader for the TypeScript literal subset kpi-bindings.ts uses
# --------------------------------------------------------------------------- #
_TOKEN = re.compile(r"""
    (?P<ws>\s+|//[^\n]*|/\*.*?\*/)
  | (?P<str>'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")
  | (?P<num>-?\d+(?:\.\d+)?)
  | (?P<ident>[A-Za-z_$][\w$]*)
  | (?P<punct>[{}\[\]:,])
""", re.S | re.X)


class _Reader:
    """Parses one value (object, array, string, number, boolean, null or a reference to
    another top-level ``const``) out of the TypeScript source."""

    def __init__(self, source: str) -> None:
        self.source = source
        self.consts: dict[str, Any] = {}
        self._starts = {
            m.group(1): m.end()
            for m in re.finditer(r"(?:export\s+)?const\s+(\w+)(?:\s*:[^=]+?)?\s*=\s*", source)
        }

    def const(self, name: str) -> Any:
        if name not in self.consts:
            assert name in self._starts, f"kpi-bindings.ts references an unknown const {name}"
            self.consts[name], _ = self._value(self._starts[name])
        return self.consts[name]

    def _next(self, pos: int) -> tuple[str, str, int]:
        while True:
            match = _TOKEN.match(self.source, pos)
            assert match is not None, f"unreadable TypeScript at {self.source[pos:pos + 40]!r}"
            kind = match.lastgroup or ""
            pos = match.end()
            if kind != "ws":
                return kind, match.group(kind), pos

    def _value(self, pos: int) -> tuple[Any, int]:
        kind, text, pos = self._next(pos)
        if kind == "str":
            return json.loads('"' + text[1:-1].replace('"', '\\"').replace("\\'", "'") + '"'), pos
        if kind == "num":
            return (float(text) if "." in text else int(text)), pos
        if kind == "ident":
            literal = {"true": True, "false": False, "null": None}
            return (literal[text] if text in literal else self.const(text)), pos
        if text == "[":
            items: list[Any] = []
            while True:
                kind, text, after = self._next(pos)
                if text == "]":
                    return items, after
                item, pos = self._value(pos)
                items.append(item)
                kind, text, after = self._next(pos)
                pos = after if text == "," else pos
        if text == "{":
            obj: dict[str, Any] = {}
            while True:
                kind, key, pos = self._next(pos)
                if key == "}":
                    return obj, pos
                key = json.loads(key) if kind == "str" else key
                _, colon, pos = self._next(pos)
                assert colon == ":", f"expected ':' after {key}"
                obj[key], pos = self._value(pos)
                kind, text, after = self._next(pos)
                if text == ",":
                    pos = after
        raise AssertionError(f"unexpected token {text!r}")


@pytest.fixture(scope="module")
def ts() -> _Reader:
    return _Reader(BINDINGS_TS.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def bindings(ts: _Reader) -> list[dict[str, Any]]:
    return ts.const("KPI_STRIP_BINDINGS")


# --------------------------------------------------------------------------- #
# Path resolution (``a.b``, ``stages[key=ingested].total``)
# --------------------------------------------------------------------------- #
_MISSING = object()


def resolve(doc: Any, path: str) -> Any:
    """The value at ``path`` or :data:`_MISSING` (never a silent default)."""
    node = doc
    for part in path.split("."):
        match = re.fullmatch(r"(\w+)\[(\w+)=([\w.-]+)\]", part)
        if match:
            name, key, want = match.groups()
            items = node.get(name) if isinstance(node, dict) else None
            if not isinstance(items, list):
                return _MISSING
            node = next((i for i in items if isinstance(i, dict) and str(i.get(key)) == want), _MISSING)
        elif isinstance(node, dict) and part in node:
            node = node[part]
        else:
            return _MISSING
        if node is _MISSING:
            return _MISSING
    return node


def _is_value(value: Any) -> bool:
    """A cell value the honesty rules accept: a finite number, null, or the dash."""
    if value is None or value == DASH:
        return True
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


# --------------------------------------------------------------------------- #
# Harness
# --------------------------------------------------------------------------- #
def _api(state: Any) -> FastAPI:
    api = FastAPI()
    for router in (main_router, metrics_router, standup_router):
        api.include_router(router, dependencies=[Depends(require_auth)])
    api.state.tlsoc = state
    return api


def _request(endpoint: str, window: str) -> tuple[str, dict[str, Any]]:
    """``(path, params)`` for one binding endpoint at the board window or ``all``."""
    method, _, target = endpoint.partition(" ")
    assert method == "GET", endpoint
    path, _, query = target.partition("?")
    params: dict[str, Any] = dict(p.split("=", 1) for p in query.split("&") if p)
    if path in ("/api/metrics/posture", "/api/metrics/noise-reduction", "/api/mitre/coverage",
                "/api/metrics/auto-close-health/recorded"):
        params["window_hours"] = BOARD_HOURS if window == "board" else (
            0 if path != "/api/metrics/auto-close-health/recorded" else 8760)
    return path, params


def _board_token(hours: int) -> str:
    """The breakdown window a board sends for its own window: the hours token
    (``now-168h``), the same rolling span every ``window_hours`` provider counts.
    ``now-7d`` would mean whole local days (chat's reading) and could count a different
    population than the posture cells beside it."""
    return f"now-{hours}h"


def _breakdown_params(query: dict[str, Any]) -> dict[str, Any]:
    params = {k: v for k, v in query.items() if k != "window"}
    params["window"] = _board_token(BOARD_HOURS) if query["window"] == "board" else "all"
    return params


async def _fetch(client: AsyncClient, path: str, params: dict[str, Any]) -> Any:
    response = await client.get(path, params=params)
    assert response.status_code == 200, (path, params, response.text)
    return response.json()


def _assert_flag(doc: Any, flag: dict[str, Any], where: str) -> None:
    value = resolve(doc, flag["field"])
    assert isinstance(value, bool), (where, flag["field"], value)
    if "reasonField" in flag:
        reason = resolve(doc, flag["reasonField"])
        assert reason is None or isinstance(reason, str), (where, flag["reasonField"], reason)


async def _check_source(client: AsyncClient, source: dict[str, Any], window: str, where: str) -> Any:
    """Every server field ``source`` names exists with the right type; returns the value
    (or the response, for the sources and stage sources)."""
    kind = source["type"]
    if kind == "field":
        doc = await _fetch(client, *_request(source["endpoint"], window))
        value = resolve(doc, source["field"])
        assert value is not _MISSING, (where, source["field"])
        assert _is_value(value), (where, source["field"], value)
        if "availableField" in source:
            assert isinstance(resolve(doc, source["availableField"]), bool), (where, source["availableField"])
            if resolve(doc, source["availableField"]) is False:
                assert value is None or value == DASH or value == 0, (where, value)
        if "reasonField" in source:
            reason = resolve(doc, source["reasonField"])
            assert reason is None or isinstance(reason, str), (where, source["reasonField"], reason)
        if "shareField" in source:
            share = resolve(doc, source["shareField"])
            assert share is not _MISSING and (_is_value(share) or isinstance(share, str)), (where, share)
        for flag in source.get("partialWhen", []):
            _assert_flag(doc, flag, where)
        return value
    if kind in ("breakdown_group", "breakdown_sum"):
        body = await _fetch(client, "/api/metrics/breakdown", _breakdown_params(source["query"]))
        MetricsBreakdown.model_validate(body)
        assert isinstance(body["partial"], bool) and isinstance(body["exact"], bool)
        assert body["partial_reason"] is None or isinstance(body["partial_reason"], str)
        other = body["other"]
        assert other is None or isinstance(other["count"], int)
        metric = source["metric"]
        for group in body["groups"]:
            assert isinstance(group[metric], (int, float)) and not isinstance(group[metric], bool), (where, metric)
        if kind == "breakdown_group":
            match = [g for g in body["groups"] if g["key"] == source["group"]]
            return match[0][metric] if match else None
        keys = source.get("keys")
        return sum(g[metric] for g in body["groups"] if keys is None or g["key"] in keys)
    if kind == "sources_health":
        doc = await _fetch(client, "/api/sources/health", {})
        for row in doc["sources"]:
            assert isinstance(row["enabled"], bool) and isinstance(row["silent"], bool), (where, row)
            assert row["last_event_millis"] is None or isinstance(row["last_event_millis"], int), (where, row)
        return doc
    if kind == "ratio":
        numerator = await _check_source(client, source["numerator"], window, where)
        denominator = await _check_source(client, source["denominator"], window, where)
        return numerator, denominator
    if kind == "stage_reduction":
        doc = await _fetch(client, *_request(source["endpoint"], window))
        for key in (source["numerator"], source["denominator"]):
            stage = resolve(doc, f"stages[key={key}]")
            assert stage is not _MISSING and _is_value(stage["total"]), (where, key)
        for flag in ("counters.available", "counters.incomplete", "cases_meta.truncated"):
            assert isinstance(resolve(doc, flag), bool), (where, flag)
        return doc
    raise AssertionError(f"{where}: unknown source type {kind}")


async def _check_every_binding(state: Any, bindings: list[dict[str, Any]]) -> dict[str, Any]:
    values: dict[str, Any] = {}
    async with AsyncClient(transport=ASGITransport(app=_api(state)), base_url="http://test") as client:
        for binding in bindings:
            where = f"{binding['group']}.{binding['cell']}"
            values[where] = await _check_source(client, binding["source"], binding["window"], where)
    return values


# --------------------------------------------------------------------------- #
# 1. The table itself
# --------------------------------------------------------------------------- #
def test_the_binding_table_is_the_spec_table(bindings: list[dict[str, Any]]) -> None:
    cells = [(b["group"], b["cell"]) for b in bindings]
    assert cells == [
        ("operations", "open_now"), ("operations", "awaiting_decision"),
        ("operations", "unassigned"), ("operations", "sla_breached"),
        ("operations", "new_cases"), ("operations", "closed"),
        ("detection", "sources_reporting"), ("detection", "silent_sources"),
        ("detection", "events_per_minute"), ("detection", "alerts_ingested"),
        ("detection", "alert_reduction"), ("detection", "techniques_seen"),
        ("executive", "cases"), ("executive", "confirmed_threats"), ("executive", "mttd_p50"),
        ("executive", "mttr_p50"), ("executive", "closed_by_agent"),
        ("executive", "sla_attainment"), ("cost_budget", "spend_per_case"),
    ]
    for binding in bindings:
        grant = binding["grant"]
        assert grant["action"] in RESOURCES[grant["resource"]], binding["cell"]
        assert "—" not in binding["definition"] and "–" not in binding["definition"]
        assert "playbook" not in (binding["label"] + binding["definition"]).lower()


def test_every_named_server_field_is_pinned(bindings: list[dict[str, Any]]) -> None:
    """The dotted fields the table reads, listed once: adding or renaming one in the
    TypeScript fails here until the server pin below covers it."""
    named: set[str] = set()

    def walk(source: dict[str, Any]) -> None:
        for key in ("field", "reasonField", "availableField", "shareField"):
            if key in source:
                named.add(f"{source.get('endpoint', '')} {source[key]}")
        for flag in source.get("partialWhen", []):
            named.add(f"{source.get('endpoint', '')} {flag['field']}")
            if "reasonField" in flag:
                named.add(f"{source.get('endpoint', '')} {flag['reasonField']}")
        for key in ("numerator", "denominator"):
            if isinstance(source.get(key), dict):
                walk(source[key])

    for binding in bindings:
        walk(binding["source"])
    posture, noise = "GET /api/metrics/posture", "GET /api/metrics/noise-reduction"
    auto = "GET /api/metrics/auto-close-health/recorded?anchor=first"
    assert named == {
        f"{posture} open_now.count", f"{posture} open_now.reason", f"{posture} open_now.complete",
        f"{posture} case_count", f"{posture} window_covered", f"{posture} window_coverage_reason",
        f"{posture} quality.terminal_cases",
        f"{posture} lifecycle.mttd_minutes.p50", f"{posture} lifecycle.mttd_minutes.reason",
        f"{posture} lifecycle.mttd_minutes.available",
        f"{posture} lifecycle.mttr_minutes.p50", f"{posture} lifecycle.mttr_minutes.reason",
        f"{posture} lifecycle.mttr_minutes.available",
        f"{posture} sla.attainment_pct", f"{posture} sla.attainment_reason",
        "GET /api/standup/report sla_aging.totals.breached", "GET /api/standup/report sla_aging.enabled",
        f"{noise} events_per_min", f"{noise} counters.available", f"{noise} counters.incomplete",
        f"{noise} stages[key=ingested].total",
        "GET /api/mitre/coverage covered_techniques", "GET /api/mitre/coverage truncated",
        f"{auto} current.auto_closed", f"{auto} current.rate", f"{auto} current.reason",
        f"{auto} current.available",
    }


def test_spend_per_case_reads_the_investigation_surfaces(ts: _Reader, bindings: list[dict[str, Any]]) -> None:
    """A2's decision (SPEC §4.4.3): the numerator is the ``cost_usd`` of the surfaces the
    investigation pipeline's router, investigator and formatter calls carry, which is the
    case's ``source_surface``: ``investigate`` and ``automated_scan``. ``chat`` is left out
    because the chat assistant's own calls share it. A role breakdown was rejected: replay
    experiments (surface ``replay``) and batched event detection (surface ``batch``) run
    under the investigator role and would be counted as investigation spend."""
    surfaces = ts.const("INVESTIGATION_USAGE_SURFACES")
    assert surfaces == ["investigate", "automated_scan"]
    assert set(surfaces) == {s.value for s in SourceSurface} - {SourceSurface.CHAT.value}
    assert not {"chat", "report", "standup", "overview", "replay", "batch", "rag"} & set(surfaces)
    spend = next(b for b in bindings if b["cell"] == "spend_per_case")["source"]
    assert spend["numerator"]["query"] == {"kind": "usage", "by": "surface", "window": "board", "top": 50}
    assert spend["numerator"]["keys"] == surfaces and spend["numerator"]["metric"] == "cost_usd"
    assert spend["denominator"]["query"] == {"by": "severity", "window": "board"}
    assert spend["denominator"]["metric"] == "verdicted"


# --------------------------------------------------------------------------- #
# 2. The server fields on a hand-built fixture, checked against the store
# --------------------------------------------------------------------------- #
def _case(cid: str, *, hours_ago: float, **kw: Any) -> Case:
    created = NOW - timedelta(hours=hours_ago)
    base: dict[str, Any] = {
        "case_id": cid, "cluster_signature": f"sig-{cid}", "title": f"Case {cid}",
        "source_surface": SourceSurface.AUTOMATED_SCAN,
        "entity": Entity(type=EntityType.IP, value=f"10.9.0.{len(cid)}"),
        "created_at": created.isoformat(),
        "first_seen_millis": int((created - timedelta(minutes=12)).timestamp() * 1000),
    }
    base.update(kw)
    return Case(**base)


def _resolved(cid: str, *, hours_ago: float, **kw: Any) -> Case:
    created = NOW - timedelta(hours=hours_ago)
    history = [
        StatusHistoryEntry(from_status="open", to_status="investigating", by="alice",
                           at=(created + timedelta(minutes=20)).isoformat()),
        StatusHistoryEntry(from_status="investigating", to_status="resolved", by="alice",
                           at=(created + timedelta(minutes=90)).isoformat()),
    ]
    return _case(cid, hours_ago=hours_ago, status=CaseStatus.RESOLVED, decision_by=DecisionBy.ANALYST,
                 status_history=history, **kw)


def _fixture_cases() -> list[Case]:
    tp = [FeedbackEntry(actual_outcome="true_positive", ts=(NOW - timedelta(hours=1)).isoformat())]
    return [
        _resolved("k1", hours_ago=5, verdict=Verdict.TRUE_POSITIVE, severity_band="critical", feedback=tp,
                  rule_ids=["r-ssh"], mitre=["T1110"]),
        _resolved("k2", hours_ago=30, verdict=Verdict.FALSE_POSITIVE, severity_band="low", rule_ids=["r-web"]),
        _case("k3", hours_ago=2, verdict=Verdict.NEEDS_HUMAN, status=CaseStatus.NEEDS_HUMAN,
              severity_band="high", rule_ids=["r-ssh"], mitre=["T1059.001"]),
        _case("k4", hours_ago=50, verdict=Verdict.NEEDS_HUMAN, status=CaseStatus.OPEN, severity_band="medium",
              assignee="bob"),
        _case("k5", hours_ago=3, verdict=Verdict.TRUE_POSITIVE, status=CaseStatus.ESCALATED,
              severity_band="critical", feedback=tp, rule_ids=["r-smb"]),
        _case("k6", hours_ago=24 * 20, verdict=Verdict.NEEDS_HUMAN, status=CaseStatus.OPEN,
              severity_band="high"),                                   # outside the board window
        _case("k7", hours_ago=10, verdict=None, status=CaseStatus.CLOSED,
              decision_by=DecisionBy.ANALYST_POLICY, analyst_policy={"policy_id": "p"},
              severity_band="low", feedback=tp),                        # policy close: never graded
    ]


@pytest.fixture
async def fixture_state(app_state) -> Any:
    for case in _fixture_cases():
        await app_state.cases.save(case)
    delta = empty_noise_delta()
    delta["ingested"]["high"] = 600
    delta["clustered"]["high"] = 40
    await app_state.noise_counters.record(delta, now=now_utc() - timedelta(hours=3))
    await app_state.noise_counters.record(delta, now=now_utc() - timedelta(minutes=30))
    for surface, role, cost in (("investigate", "investigator", 0.4), ("automated_scan", "router", 0.1),
                                ("automated_scan", "formatter", 0.05), ("chat", "chat", 3.0)):
        await app_state.usage_store.write_strict(UsageDoc(
            ts=(NOW - timedelta(hours=1)).isoformat(), surface=surface, role=role, model="claude-sonnet-4-5",
            cost=cost, prompt_tokens=10, completion_tokens=5, total_tokens=15,
        ))
    return app_state


async def test_every_binding_reads_real_fields_with_true_values_on_a_fixture(
    fixture_state: Any, bindings: list[dict[str, Any]],
) -> None:
    values = await _check_every_binding(fixture_state, bindings)
    cases = _fixture_cases()
    in_board = [c for c in cases if parse_es_timestamp(c.created_at) >= NOW - timedelta(hours=BOARD_HOURS)]
    open_cases = [c for c in cases if c.status.value in _ACTIVE]

    assert values["operations.open_now"] == len(open_cases) == 4
    assert values["operations.awaiting_decision"] == sum(
        1 for c in open_cases if c.verdict == Verdict.NEEDS_HUMAN) == 3
    assert values["operations.unassigned"] == sum(1 for c in open_cases if not c.assignee.strip()) == 3
    assert isinstance(values["operations.sla_breached"], int)
    assert values["operations.new_cases"] == values["executive.cases"] == len(in_board) == 6
    # posture quality.terminal_cases leaves analyst-policy closes out (k7), as every
    # quality figure does; the help tip must say so (recorded for kpi-bindings.ts).
    assert values["operations.closed"] == sum(
        1 for c in in_board if c.status.value in _TERMINAL and not is_policy_closed(c)) == 2
    # Counters: 1,200 alerts in the window; the stage-reduction source is the funnel.
    assert values["detection.alerts_ingested"] == 1200
    assert isinstance(values["detection.events_per_minute"], float)
    assert values["detection.techniques_seen"] == 2
    # Analyst outcome only, policy closes excluded: k1 and k5 (k7's feedback is not counted).
    assert values["executive.confirmed_threats"] == sum(
        1 for c in in_board
        if not is_policy_closed(c) and analyst_confirmed_outcome(c)[0] == "true_positive") == 2
    assert values["executive.mttd_p50"] == pytest.approx(12.0)
    assert values["executive.mttr_p50"] == pytest.approx(90.0)
    numerator, denominator = values["cost_budget.spend_per_case"]
    assert numerator == pytest.approx(0.55)             # investigate + automated_scan, never chat
    assert denominator == sum(1 for c in in_board if c.verdict is not None and not is_policy_closed(c)) == 5


async def test_mttd_and_mttr_carry_available_and_the_window_flags(fixture_state: Any) -> None:
    async with AsyncClient(transport=ASGITransport(app=_api(fixture_state)), base_url="http://test") as client:
        posture = await _fetch(client, "/api/metrics/posture", {"window_hours": BOARD_HOURS})
        assert posture["window_covered"] is True and posture["window_coverage_reason"] == ""
        for clock in ("mttd_minutes", "mttr_minutes"):
            assert posture["lifecycle"][clock]["available"] is True
        recorded = await _fetch(client, "/api/metrics/auto-close-health/recorded",
                                {"window_hours": BOARD_HOURS, "anchor": "first"})
        # No decision trail in this fixture: never "0 closed by the agent".
        assert recorded["current"]["available"] is False and recorded["current"]["reason"]
        report = await _fetch(client, "/api/standup/report", {})
        assert report["sla_aging"]["enabled"] is True
        assert isinstance(report["sla_aging"]["totals"]["breached"], int)
        noise = await _fetch(client, "/api/metrics/noise-reduction", {"window_hours": BOARD_HOURS})
        assert noise["counters"]["available"] is True
        assert noise["counters"]["incomplete"] is True   # the counters began 3 hours ago


# --------------------------------------------------------------------------- #
# 3. The server fields on the Demo dataset
# --------------------------------------------------------------------------- #
async def test_every_binding_reads_real_fields_on_the_demo_dataset(app_state, bindings) -> None:
    await app_state.enable_demo(mode="seeded", seed=1337, history_days=30)
    try:
        values = await _check_every_binding(app_state, bindings)
        assert values["operations.open_now"] > 0 and values["executive.cases"] > 0
        sources = values["detection.sources_reporting"]["sources"]
        assert sources and all(row["enabled"] for row in sources)   # the Demo simulators
    finally:
        await app_state.disable_demo()


# --------------------------------------------------------------------------- #
# 3b. One window per board: breakdown cells count what the posture cells count
# --------------------------------------------------------------------------- #
_BOARD_WINDOWS_HOURS = (24, 168, 720, 2160)


async def _assert_one_population(state: Any) -> None:
    """For every board window, the posture ``case_count`` (rolling ``window_hours``)
    equals the summed ``count`` of the severity breakdown over the board's hours token
    (severity is single-valued, so its rows partition the window), and so does the
    verdicted denominator the spend cell divides by."""
    async with AsyncClient(transport=ASGITransport(app=_api(state)), base_url="http://test") as client:
        for hours in _BOARD_WINDOWS_HOURS:
            posture = await _fetch(client, "/api/metrics/posture", {"window_hours": hours})
            body = await _fetch(client, "/api/metrics/breakdown",
                                {"by": "severity", "window": _board_token(hours), "top": 50})
            assert body["exact"] is True and posture["window_covered"] is True, hours
            assert sum(g["count"] for g in body["groups"]) == body["total"] == posture["case_count"], hours
            # The window the breakdown measured is the rolling span, not whole days.
            start = parse_es_timestamp(body["window_from"])
            end = parse_es_timestamp(body["window_to"])
            assert abs((end - start).total_seconds() - hours * 3600) < 1, hours


async def test_breakdown_cells_count_the_posture_population_on_a_fixture(fixture_state: Any) -> None:
    await _assert_one_population(fixture_state)


async def test_breakdown_cells_count_the_posture_population_on_the_demo_dataset(app_state) -> None:
    await app_state.enable_demo(mode="seeded", seed=1337, history_days=30)
    try:
        await _assert_one_population(app_state)
    finally:
        await app_state.disable_demo()


def test_a_days_token_keeps_chats_whole_day_reading() -> None:
    """The board sends hours; ``now-7d`` keeps meaning whole local days (chat parity),
    which is why a board never sends it for a cell beside a posture cell."""
    days = align_whole_periods(resolve_window("now-7d"))
    hours = align_whole_periods(resolve_window(_board_token(168)))
    assert days.start is not None and hours.start is not None
    assert days.start.astimezone(UTC).time() == datetime.min.time()       # local midnight (UTC)
    assert hours.end is not None and abs((hours.end - hours.start).total_seconds() - 168 * 3600) < 1


# --------------------------------------------------------------------------- #
# 4. events_per_min (new in Round 14)
# --------------------------------------------------------------------------- #
async def _noise(state: Any, window_hours: int) -> dict[str, Any]:
    async with AsyncClient(transport=ASGITransport(app=_api(state)), base_url="http://test") as client:
        return await _fetch(client, "/api/metrics/noise-reduction", {"window_hours": window_hours})


def _delta(count: int) -> dict[str, Any]:
    delta = empty_noise_delta()
    delta["ingested"]["medium"] = count
    return delta


async def test_events_per_min_is_null_while_the_counters_are_unavailable(app_state) -> None:
    body = await _noise(app_state, 24)
    assert body["counters"]["available"] is False and body["events_per_min"] is None
    assert body["events_per_min_since"] is None
    assert body["events_per_min_reason"] == (
        "The alert counters are not available yet, so the rate is not measured."
    )


def _hour_start(moment: datetime) -> float:
    return math.floor(moment.timestamp() / 3600.0) * 3600.0


async def test_events_per_min_leaves_out_the_hour_the_counters_began_in(app_state) -> None:
    """The counters began inside the window (``incomplete``): the hour they began in can
    hold a backfilled burst, so the rate is the later hours over the minutes since the
    next hour boundary, never the whole tally over the minutes since the first record."""
    began = now_utc() - timedelta(hours=2)
    await app_state.noise_counters.record(_delta(900), now=began)
    await app_state.noise_counters.record(_delta(300), now=now_utc() - timedelta(minutes=10))
    before = now_utc()
    body = await _noise(app_state, 24)
    after = now_utc()
    assert body["counters"]["incomplete"] is True
    assert resolve(body, "stages[key=ingested].total") == 1200     # the stage still counts all
    measured_from = _hour_start(began) + 3600.0                     # 60 to 120 minutes ago
    lo = 300 / ((after.timestamp() - measured_from) / 60.0)
    hi = 300 / ((before.timestamp() - measured_from) / 60.0)
    assert lo - 0.01 <= body["events_per_min"] <= hi + 0.01
    assert body["events_per_min"] < 1200 / 60.0                     # the old reading
    # The span measured is said, so the cell never reads as covering the whole window
    # beside "Alerts ingested" (which does).
    assert parse_es_timestamp(body["events_per_min_since"]).timestamp() == measured_from
    assert body["events_per_min_reason"] == (
        "The alert counters started inside this window, so the rate covers only the time "
        "since the end of the hour they started in."
    )


async def test_a_backfilled_burst_is_never_read_as_a_rate(app_state) -> None:
    """A first poll's cold-start lookback (or a Demo's history) lands in one hour. The
    steady hours after it, about one alert a minute, decide the rate."""
    began = now_utc() - timedelta(hours=3)
    await app_state.noise_counters.record(_delta(10_000), now=began)     # the burst
    for hours_ago in (2, 1):
        await app_state.noise_counters.record(_delta(60), now=now_utc() - timedelta(hours=hours_ago))
    await app_state.noise_counters.record(_delta(30), now=now_utc() - timedelta(minutes=1))
    body = await _noise(app_state, 24)
    rate = body["events_per_min"]
    assert isinstance(rate, float) and 0.2 <= rate <= 2.0          # 10,000 / 180 would be 55
    # The two hourly records fall in the two hours after the burst's hour, whatever the
    # minute: everything but the burst is counted, from the next hour boundary.
    measured_from = _hour_start(began) + 3600.0
    minutes = (now_utc().timestamp() - measured_from) / 60.0
    assert rate == pytest.approx((60 + 60 + 30) / minutes, abs=0.05)


async def test_events_per_min_over_a_window_the_counters_fully_cover(app_state) -> None:
    await app_state.noise_counters.record(_delta(5000), now=now_utc() - timedelta(hours=30))
    await app_state.noise_counters.record(_delta(1440), now=now_utc() - timedelta(minutes=5))
    body = await _noise(app_state, 24)
    assert body["counters"]["incomplete"] is False
    ingested = resolve(body, "stages[key=ingested].total")
    assert ingested == 1440                               # the 30-hour-old hour is outside
    # The summed hours start on the hour the window begins in.
    now = now_utc()
    first_hour = math.floor((now.timestamp() - 24 * 3600) / 3600) * 3600
    minutes = (now.timestamp() - first_hour) / 60.0
    assert body["events_per_min"] == pytest.approx(round(1440 / minutes, 2), abs=0.02)
    # The whole window was measured: it starts on the window's first hour, no reason.
    assert parse_es_timestamp(body["events_per_min_since"]).timestamp() == first_hour
    assert body["events_per_min_reason"] is None
    # All time: the counters began inside it, so the hour they began in (5,000 at once)
    # is left out and the rate runs from the next hour boundary.
    whole = await _noise(app_state, 0)
    began = parse_es_timestamp(whole["counters"]["coverage_start"])
    measured_from = _hour_start(began) + 3600.0
    expected = 1440 / ((now_utc().timestamp() - measured_from) / 60.0)
    assert whole["events_per_min"] == pytest.approx(expected, rel=0.01)


async def test_events_per_min_is_not_stated_over_a_few_seconds(app_state) -> None:
    """Counters that began moments ago have no whole hour after the one they began in, so
    there is nothing steady to divide: the rate is not measured (never 164 per minute)."""
    await app_state.noise_counters.record(_delta(164), now=now_utc() - timedelta(seconds=3))
    body = await _noise(app_state, 24)
    assert body["counters"]["available"] is True
    assert resolve(body, "stages[key=ingested].total") == 164
    assert body["events_per_min"] is None and body["events_per_min_since"] is None
    assert body["events_per_min_reason"] == (
        "The alert counters started recently: the hour they started in is left out, and "
        "fewer than five minutes have been measured since."
    )
    assert _EVENTS_PER_MIN_MIN_SPAN_MINUTES == 5.0


async def test_events_per_min_on_the_demo_dataset_is_not_its_history_burst(app_state) -> None:
    """A Demo writes its whole alert history into the counters when it is turned on: the
    rate is not measured until a steady hour has passed, never the history over minutes."""
    await app_state.enable_demo(mode="seeded", seed=7, history_days=14)
    try:
        body = await _noise(app_state, 24)
        assert body["counters"]["available"] is True
        assert (resolve(body, "stages[key=ingested].total") or 0) > 0
        assert body["events_per_min"] is None
        assert isinstance(body["events_per_min_reason"], str) and body["events_per_min_reason"]
    finally:
        await app_state.disable_demo()


async def test_events_per_min_degrades_when_the_hourly_read_fails(app_state, monkeypatch) -> None:
    await app_state.noise_counters.record(_delta(900), now=now_utc() - timedelta(hours=3))
    await app_state.noise_counters.record(_delta(60), now=now_utc() - timedelta(minutes=2))

    async def boom(*_a: Any, **_kw: Any) -> Any:
        raise RuntimeError("kv down")

    monkeypatch.setattr(app_state.noise_counters, "read_hourly_ingested", boom)
    body = await _noise(app_state, 24)
    assert body["counters"]["available"] is True and body["events_per_min"] is None
    assert body["events_per_min_reason"] == (
        "The hourly alert counters could not be read, so the rate is not measured."
    )
    assert "kv down" not in json.dumps(body)


async def test_every_events_per_min_reason_is_plain_text(app_state) -> None:
    from app.api import routes_metrics

    reasons = [value for name, value in vars(routes_metrics).items() if name.startswith("_EPM_")]
    assert len(reasons) == 6
    for reason in reasons:
        assert reason[:1].isupper() and reason.endswith(".")
        assert "—" not in reason and "–" not in reason and "{" not in reason


# --------------------------------------------------------------------------- #
# 5. The investigation pipeline's calls carry the case surface
# --------------------------------------------------------------------------- #
def _investigation_client(secrets: Any, mock_provider: Any) -> TestClient:
    from app.es.fake import InMemoryESClient
    from app.state import AppState

    overrides = {"anthropic": mock_provider, "openai": mock_provider, "mock": mock_provider}

    @asynccontextmanager
    async def lifespan(api: FastAPI):
        state = AppState.create(secrets=secrets, es=InMemoryESClient(), provider_overrides=overrides)
        await state.startup(start_poller=False)
        await state.update_prefs(state.prefs.model_copy(update={"setup_complete": True}))
        api.state.tlsoc = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    api.include_router(main_router)
    api.include_router(metrics_router)
    return TestClient(api)


def test_investigation_calls_land_on_the_investigation_surfaces(secrets, mock_provider) -> None:
    ip = "203.0.113.77"
    with _investigation_client(secrets, mock_provider) as client:
        state = client.app.state.tlsoc
        state.es.add_log("all-logs-2026.10.26", make_log_event(ip=ip, ts_millis=to_millis(now_utc())))
        mock_provider.push("router", json.dumps(
            {"bucket": "needs_strong_model", "confidence": 0.9, "reason": "serious"}))
        mock_provider.push("investigator", json.dumps({
            "action": "final", "reasoning": "scripted",
            "verdict": {"verdict": "NEEDS_HUMAN", "confidence": 0.4,
                        "evidence": [{"summary": "scripted", "event_ids": []}], "mitre": ["T1110"],
                        "recommended_action": "review", "reproduce_query": f"ip:{ip}"},
        }))
        created = client.post("/api/investigate", json={"entity": {"type": "ip", "value": ip}})
        assert created.status_code == 200, created.text
        assert created.json()["source_surface"] == "investigate"
        rows = client.portal.call(lambda: state.usage_store.records(limit=1000))  # type: ignore[union-attr]
        pipeline = [r for r in rows if r.get("role") in CASE_PIPELINE_USAGE_ROLES]
        assert pipeline, "the investigation made no metered call"
        assert {r["surface"] for r in pipeline} == {"investigate"}
        usage = client.get("/api/metrics/breakdown",
                           params={"kind": "usage", "by": "surface", "window": "now-24h", "top": 50})
        assert usage.status_code == 200, usage.text
        by_surface = {g["key"]: g for g in usage.json()["groups"]}
        assert by_surface["investigate"]["calls"] == len(
            [r for r in rows if r.get("surface") == "investigate"])
        # The ledger engine reports spend to the micro-dollar.
        assert by_surface["investigate"]["cost_usd"] == pytest.approx(
            sum(float(r.get("cost") or 0) for r in rows if r.get("surface") == "investigate"), abs=1e-6)
