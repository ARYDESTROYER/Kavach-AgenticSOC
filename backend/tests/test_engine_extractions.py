"""Chat revamp SPEC §5.3 — route-private helpers moved to engine modules, unchanged.

The chat tools need the case rationale, the cluster reconstruction, the source-health
rows, the browse-row projection + multi-source fan-out, and the proposal/campaign
projections WITHOUT importing the HTTP layer. These tests pin that the move kept
behaviour and every historical import path intact:

* every old underscore name is still importable from its old module, and the pure
  re-exports ARE the moved objects (so tests and ``routes_rules`` keep working);
* the ``AppState``-reading wrappers keep their old signatures and return exactly what
  the engine function returns when handed the same dependencies explicitly;
* the engine functions behave on fixtures as the route helpers always did (widening
  ladder, signature pinning, fail-soft health rows, partial-success fan-out);
* ``GET /api/logs`` and a direct ``fan_out`` over the same state agree byte-for-byte.

Several parity checks here compare the route with the engine function it now calls, so
on their own they cannot catch a regression against the PRE-move behaviour. That pinning
lives in the existing route suites (``test_browse_and_connection``,
``test_round4_wave4_routes_monolith``, the RBAC suites), which still run against the
routes unchanged, plus the golden-envelope tests below that fix the expected output
literally.

All offline: fake ES, mock LLM, stub collaborators.
"""

from __future__ import annotations

import asyncio
import inspect
from types import SimpleNamespace

import pytest

from app.api import routes, routes_campaigns
from app.config import Preferences, SourceInstance
from app.connectors.base import StructuredQuery
from app.connectors.registry import get_registry
from app.constants import ActionType, EntityType, SourceSurface, SourceType
from app.engine import case_cluster, case_rationale, log_rows, source_health, views
from app.models import (
    Campaign,
    CampaignEntity,
    Case,
    Entity,
    Proposal,
    RawEvent,
    TriggerReason,
)
from app.utils import now_utc, to_millis
from tests.conftest import make_log_event, make_raw_event, seed_logs


# --------------------------------------------------------------------------- #
# Old names stay importable from their old modules
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    ("module", "old_name", "moved"),
    [
        (routes, "_build_rationale", case_rationale.build_rationale),
        (routes, "_audit_get", case_rationale.audit_get),
        (routes, "_reconstruct_cluster_from_case", case_cluster.reconstruct_cluster_from_case),
        (routes, "_manual_trigger_reason", case_cluster.manual_trigger_reason),
        (routes, "_entity_field", case_cluster.entity_field),
        (routes, "_scoped_entity_body", case_cluster.scoped_entity_body),
        (routes, "_widen_windows", case_cluster.widen_windows),
        (routes, "_WIDEN_LADDER", case_cluster.WIDEN_LADDER),
        (routes, "_log_row", log_rows.log_row),
        (routes, "_log_message", log_rows.log_message),
        (routes, "_browse_truncated", log_rows.browse_truncated),
        (routes, "_source_can_browse", log_rows.source_can_browse),
        (routes, "_wallclock_last_event_millis", source_health.wallclock_last_event_millis),
        (routes, "_proposal_public", views.proposal_public),
        (routes_campaigns, "_campaign_json", views.campaign_json),
        (routes_campaigns, "_safe", views.safe_text),
    ],
)
def test_pure_reexports_are_the_moved_objects(module, old_name, moved):
    assert getattr(module, old_name) is moved


def test_state_reading_wrappers_keep_their_historical_signatures():
    # Route code and tests call these with ``state`` first; the move must not change it.
    sig = inspect.signature(routes._cluster_for_case)
    assert list(sig.parameters) == [
        "state", "case", "allow_stored_reconstruction", "query_source",
    ]
    assert sig.parameters["allow_stored_reconstruction"].default is False
    assert sig.parameters["query_source"].default is None
    assert list(inspect.signature(routes._entity_events_widening).parameters) == [
        "state", "entity_type", "value", "start_window", "query_source",
    ]
    assert list(inspect.signature(routes._sources_health_rows).parameters) == ["state"]
    assert list(inspect.signature(routes._cursor_millis).parameters) == ["state", "src"]
    for fn in (
        routes._cluster_for_case, routes._entity_events_widening,
        routes._sources_health_rows, routes._cursor_millis,
    ):
        assert inspect.iscoroutinefunction(fn)


def test_moved_modules_do_not_import_the_http_layer():
    """The whole point of the move: an agent-layer consumer must not drag in FastAPI
    routes (or the ``AppState``) by importing these engine modules."""
    import ast
    from pathlib import Path

    for mod in (case_rationale, case_cluster, log_rows, source_health, views):
        tree = ast.parse(Path(mod.__file__).read_text())
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom):
                target = "." * node.level + (node.module or "")
                assert "api" not in target.split("."), (mod.__name__, target)
                assert target not in ("..state", "app.state"), (mod.__name__, target)


# --------------------------------------------------------------------------- #
# case_rationale
# --------------------------------------------------------------------------- #
def test_build_rationale_projects_the_latest_run_and_works_through_both_names():
    rows = [
        # An earlier run that must NOT leak into the latest projection.
        {"actor": "playbook_selector", "action_type": "decision", "result_summary": "old"},
        {"actor": "agent", "action_type": ActionType.TOOL_CALL.value, "tool_name": "stale"},
        # The latest run.
        {"actor": "playbook_selector", "action_type": "decision", "result_summary": "chose pb"},
        {"actor": "agent", "action_type": ActionType.ES_QUERY.value,
         "query_text": "source.ip:1.2.3.4", "tool_output_summary": "3 hits"},
        {"actor": "investigator", "action_type": ActionType.VERDICT.value,
         "result_summary": "verdict=fp reasoning=benign scanner"},
        {"actor": "case_manager", "action_type": ActionType.DECISION.value,
         "result_summary": "closed by policy"},
    ]
    out = case_rationale.build_rationale("case-1", None, rows)
    assert out == routes._build_rationale("case-1", None, rows)
    assert out["tools"] == [
        {"tool": "es_query", "query": "source.ip:1.2.3.4", "summary": "3 hits"},
    ]
    assert out["reasoning"] == "benign scanner"
    assert out["decision_rationale"] == "closed by policy"
    assert out["playbook"]["reason"] == "chose pb"
    # Missing procedure telemetry stays UNKNOWN, never a measured zero.
    assert out["procedure_provenance"]["retrieval_status"] == "unavailable"


def test_audit_get_reads_dicts_and_models_alike():
    assert case_rationale.audit_get({"actor": "x"}, "actor") == "x"
    assert case_rationale.audit_get(SimpleNamespace(actor="y"), "actor") == "y"
    assert case_rationale.audit_get({}, "missing", "d") == "d"


# --------------------------------------------------------------------------- #
# case_cluster
# --------------------------------------------------------------------------- #
class _RecordingES:
    """A log client that answers only on the Nth search, recording every call."""

    def __init__(self, hit_on_call: int | None, hit: dict | None = None):
        self.calls: list[tuple[str, dict]] = []
        self._hit_on_call = hit_on_call
        self._hit = hit

    async def search_logs(self, index, body):
        self.calls.append((index, body))
        if self._hit_on_call is not None and len(self.calls) == self._hit_on_call:
            return {"hits": {"hits": [self._hit]}}
        return {"hits": {"hits": []}}


def _hit(ip: str = "198.51.100.7", doc_id: str = "h1") -> dict:
    return {"_id": doc_id, "_index": "all-logs-x", "_source": make_log_event(ip=ip)}


async def test_entity_events_widening_walks_the_ladder_with_explicit_deps():
    prefs = Preferences()
    es = _RecordingES(hit_on_call=3, hit=_hit())
    events, window = await case_cluster.entity_events_widening(
        EntityType.IP, "198.51.100.7", "now-24h", es=es, prefs=prefs,
    )
    # now-24h → now-7d → now-30d: the third window is the first with events.
    assert window == "now-30d"
    assert [e.id for e in events] == ["h1"]
    assert [index for index, _ in es.calls] == [prefs.data_view_pattern] * 3

    empty = _RecordingES(hit_on_call=None)
    events, widest = await case_cluster.entity_events_widening(
        EntityType.IP, "198.51.100.7", "now-24h", es=empty, prefs=prefs,
    )
    assert events == [] and widest == "now-365d"
    assert len(empty.calls) == len(case_cluster.widen_windows("now-24h")) == 4


async def test_entity_events_widening_uses_the_query_source_and_never_es():
    seen: list[StructuredQuery] = []

    class _Source:
        async def search(self, prefs, sq):
            seen.append(sq)
            return SimpleNamespace(events=[make_raw_event(id="q1", user="mallory")])

    class _ForbiddenES:
        async def search_logs(self, *a, **k):  # pragma: no cover — must never run
            raise AssertionError("the global log client must not be queried")

    events, window = await case_cluster.entity_events_widening(
        EntityType.USER, "mallory", "now-24h",
        es=_ForbiddenES(), prefs=Preferences(), query_source=_Source(),
    )
    assert [e.id for e in events] == ["q1"] and window == "now-24h"
    assert seen[0].user == "mallory" and seen[0].time_from == "now-24h"

    # The source-neutral IR has no domain field: no silent fallback to another source.
    events, widest = await case_cluster.entity_events_widening(
        EntityType.DOMAIN, "evil.example", "now-24h",
        es=_ForbiddenES(), prefs=Preferences(), query_source=_Source(),
    )
    assert events == [] and widest == "now-365d"
    assert len(seen) == 1


def _case(**kw) -> Case:
    base = dict(
        case_id="case-x",
        cluster_signature="sig-pinned",
        source_surface=SourceSurface.AUTOMATED_SCAN,
        entity=Entity(type=EntityType.IP, value="198.51.100.9"),
    )
    base.update(kw)
    return Case(**base)


async def test_cluster_for_case_wrapper_matches_the_engine_with_explicit_deps(app_state):
    ids = seed_logs(
        app_state.es,
        [make_log_event(ip="198.51.100.9") for _ in range(3)],
        index="all-logs-2026.10.08",
    )
    case = _case(member_event_ids=ids)

    via_route = await routes._cluster_for_case(app_state, case)
    via_engine = await case_cluster.cluster_for_case(
        case,
        es=app_state.es,
        log_source=app_state.log_source,
        prefs=app_state.execution_prefs,
    )
    assert via_route is not None and via_engine is not None
    assert via_route.model_dump(mode="json") == via_engine.model_dump(mode="json")
    # Re-investigation updates THIS case: the signature is pinned (#4), and a case
    # without a stored trigger reason gets a synthesized manual one.
    assert via_engine.signature == "sig-pinned"
    assert sorted(via_engine.member_event_ids) == sorted(ids)
    assert via_engine.trigger_reason is not None
    assert via_engine.trigger_reason.mode == "manual"


async def test_bind_cluster_for_case_resolves_the_source_per_case_and_never_reconstructs():
    resolved: list[str | None] = []

    class _Source:
        async def fetch_by_ids(self, prefs, ids, size):
            return SimpleNamespace(events=[make_raw_event(id=i, ip="198.51.100.9") for i in ids])

        async def search(self, prefs, sq):
            return SimpleNamespace(events=[])

    def _resolver(source_id):
        resolved.append(source_id)
        return _Source() if source_id == "src-live" else None

    class _ForbiddenES:
        async def search_logs(self, *a, **k):  # pragma: no cover — must never run
            raise AssertionError("a scoped case must not fall back to the global client")

    bound = case_cluster.bind_cluster_for_case(
        es=_ForbiddenES(), log_source=None, prefs=Preferences(), query_source_for=_resolver,
    )
    live = await bound(_case(source_id="src-live", member_event_ids=["m1", "m2"]))
    assert live is not None and live.count == 2 and live.source_id == "src-live"

    # A push/deleted source has no query surface. The explainer binding never fabricates
    # a cluster from stored fields, so it reports None ("unknown") instead.
    gone = await bound(_case(source_id="src-push", member_event_ids=["m1"], rule_ids=["r"]))
    assert gone is None
    assert resolved == ["src-live", "src-push"]


def test_reconstruct_cluster_from_case_pins_identity_or_returns_none():
    assert case_cluster.reconstruct_cluster_from_case(_case()) is None
    rebuilt = case_cluster.reconstruct_cluster_from_case(
        _case(
            member_event_ids=["e1", "e2", "e1"],
            rule_ids=["ssh_bruteforce"],
            source_id="src-a",
            trigger_reason=TriggerReason(window_start=1_000, window_end=3_000),
        )
    )
    assert rebuilt is not None
    assert rebuilt.signature == "sig-pinned"
    assert rebuilt.source_id == "src-a"
    assert rebuilt.rule_values == ["ssh_bruteforce"]
    assert [e.id for e in rebuilt.member_events] == ["e1", "e2"]
    assert [e.timestamp_millis for e in rebuilt.member_events] == [1_000, 3_000]


def test_manual_trigger_reason_sentence():
    cluster = case_cluster.reconstruct_cluster_from_case(
        _case(member_event_ids=["e1"], rule_ids=["r1"])
    )
    reason = case_cluster.manual_trigger_reason(cluster, "now-7d")
    assert reason.mode == "manual"
    assert reason.sentence == (
        "Manually investigated: 1 event for ip 198.51.100.9 in the last now-7d "
        "across rules [r1]"
    )


# --------------------------------------------------------------------------- #
# source_health
# --------------------------------------------------------------------------- #
def _sources_prefs() -> Preferences:
    return Preferences(sources=[
        SourceInstance(id="pull-a", source_type=SourceType.ELASTICSEARCH, is_primary=True),
        SourceInstance(id="push-b", source_type=SourceType.WEBHOOK, display_name="Hook"),
        SourceInstance(id="pull-off", source_type=SourceType.ELASTICSEARCH, enabled=False),
    ])


async def test_sources_health_rows_reads_only_its_explicit_inputs():
    prefs = _sources_prefs()
    loaded: list[str] = []

    class _Cursors:
        async def load_keyed(self, key):
            loaded.append(key)
            return SimpleNamespace(timestamp_millis=1_700_000_000_000)

    class _Poller:
        def last_tick_by_source(self):
            return {"pull-a": {"ts": "2026-10-08T00:00:00Z", "ok": False,
                               "error": "upstream said no", "events_per_min": "2.5"}}

    class _Ingest:
        def recent_events_for_source(self, source_id, limit):
            return [object()] * 4 if source_id == "push-b" else []

        def events_per_min_for_source(self, source_id):
            return 7.0

    rows = await source_health.sources_health_rows(
        prefs,
        poller=_Poller(),
        silent_sources=lambda p: ["push-b"] if p is prefs else [],
        cursor_store=_Cursors(),
        ingest_service=_Ingest(),
        last_event_map={},
    )
    by_id = {r["source_id"]: r for r in rows}
    assert list(by_id) == ["pull-a", "push-b", "pull-off"]
    pull = by_id["pull-a"]
    assert pull["kind"] == "pull" and pull["last_poll_millis"] == 1_700_000_000_000
    assert pull["last_event_millis"] == 1_700_000_000_000
    assert pull["last_poll_ok"] is False and pull["last_poll_error"] == "upstream said no"
    assert pull["events_per_min"] == 2.5
    push = by_id["push-b"]
    assert push["kind"] == "push" and push["source_name"] == "Hook"
    assert push["buffer_depth"] == 4 and push["events_per_min"] == 7.0
    assert push["silent"] is True
    # A disabled pull source is listed but never polled for a cursor.
    assert by_id["pull-off"]["last_poll_millis"] == 0
    assert loaded == ["primary"]


async def test_sources_health_rows_fails_soft_without_collaborators():
    rows = await source_health.sources_health_rows(
        _sources_prefs(), poller=None, silent_sources=None, cursor_store=None,
    )
    assert [r["source_id"] for r in rows] == ["pull-a", "push-b", "pull-off"]
    assert all(r["last_poll_millis"] == 0 and r["silent"] is False for r in rows)
    assert all(r["buffer_depth"] == 0 for r in rows)


async def test_sources_health_wrapper_matches_the_engine(app_state):
    await app_state.update_prefs(app_state.prefs.model_copy(update={
        "sources": _sources_prefs().sources,
    }))
    via_route = await routes._sources_health_rows(app_state)
    via_engine = await source_health.sources_health_rows(
        app_state.prefs,
        poller=app_state.poller,
        silent_sources=app_state.silent_sources,
        cursor_store=app_state.cursor_store,
        ingest_service=app_state.ingest_service,
        last_event_map=app_state._source_last_event,
    )
    assert via_route == via_engine
    assert [r["source_id"] for r in via_route] == ["pull-a", "push-b", "pull-off"]
    assert await routes._cursor_millis(app_state, app_state.prefs.sources[0]) == (
        await source_health.cursor_millis(app_state.cursor_store, app_state.prefs.sources[0])
    )


def test_coverage_rollup_counts_enabled_sources_only():
    now_ms = 1_700_000_100_000
    rows = [
        {"enabled": True, "silent": True, "events_per_min": 2.004,
         "last_event_millis": now_ms - 90_500},
        {"enabled": True, "silent": False, "events_per_min": "1.5",
         "last_event_millis": now_ms - 10_000},
        {"enabled": True, "silent": False, "events_per_min": None, "last_event_millis": 0},
        # Disabled: listed in the total, ignored for every other number.
        {"enabled": False, "silent": True, "events_per_min": 99.0,
         "last_event_millis": now_ms - 9_999_000},
    ]
    assert source_health.coverage_rollup(rows, now_ms) == {
        "sources_total": 4, "sources_enabled": 3, "sources_silent": 1,
        "events_per_min": 3.5, "worst_last_event_seconds": 90,
    }
    # No enabled source has ever reported: the worst age is 0, not "now".
    assert source_health.coverage_rollup([], now_ms) == {
        "sources_total": 0, "sources_enabled": 0, "sources_silent": 0,
        "events_per_min": 0.0, "worst_last_event_seconds": 0,
    }
    # A last event stamped in the future never yields a negative age.
    future = [{"enabled": True, "last_event_millis": now_ms + 60_000}]
    assert source_health.coverage_rollup(future, now_ms)["worst_last_event_seconds"] == 0


def test_sources_coverage_route_is_the_rollup_plus_the_case_count(client, monkeypatch):
    """The route keeps only ``alerts_triaged_24h`` (and the demo flag); every
    source-derived number is :func:`coverage_rollup` over the same health rows, and the
    envelope keeps its historical key order."""
    rows = [
        {"enabled": True, "silent": True, "events_per_min": 4.25, "last_event_millis": 1},
        {"enabled": False, "silent": False, "events_per_min": 1.0, "last_event_millis": 0},
    ]

    async def _rows(_state):
        return rows

    monkeypatch.setattr(routes, "_sources_health_rows", _rows)
    out = client.get("/api/sources/coverage").json()
    assert list(out) == [
        "sources_total", "sources_enabled", "sources_silent", "events_per_min",
        "alerts_triaged_24h", "worst_last_event_seconds",
    ]
    rollup = source_health.coverage_rollup(rows, to_millis(now_utc()))
    assert {k: out[k] for k in rollup if k != "worst_last_event_seconds"} == {
        k: v for k, v in rollup.items() if k != "worst_last_event_seconds"
    }
    # The two wall clocks differ by the request's duration, never by more than a second.
    assert abs(out["worst_last_event_seconds"] - rollup["worst_last_event_seconds"]) <= 1
    assert out["alerts_triaged_24h"] == 0 and "demo" not in out


# --------------------------------------------------------------------------- #
# log_rows — the scatter-gather core
# --------------------------------------------------------------------------- #
def _row(ts: str, rid: str) -> dict:
    return {"id": rid, "ts": ts, "source_id": "forged", "source_name": "forged"}


async def test_fan_out_reports_partial_success_timeouts_and_provenance():
    async def ok_reader(sq):
        return [_row("2026-10-08T00:00:01+00:00", "a1"), _row("2026-10-08T00:00:03+00:00", "a2")], 9

    async def failing_reader(sq):
        raise RuntimeError("source is down")

    async def slow_reader(sq):
        await asyncio.sleep(5)
        return [], None  # pragma: no cover

    async def push_reader(sq):
        return [_row("2026-10-08T00:00:02+00:00", "b1")], None

    targets = [
        log_rows.BrowseTarget("a", "Alpha", "search", ok_reader),
        log_rows.BrowseTarget("bad", "Bad", "search", failing_reader),
        log_rows.BrowseTarget("slow", "Slow", "search", slow_reader),
        log_rows.BrowseTarget("b", "Beta", "buffer", push_reader),
    ]
    out = await log_rows.fan_out(
        targets, log_rows.browse_query(limit=2), per_source_timeout=0.05,
    )
    assert out["partial"] is True and out["limit"] == 2
    # Newest-first merge, capped at the limit; provenance always overwritten.
    assert [r["id"] for r in out["logs"]] == ["a2", "b1"]
    assert {(r["source_id"], r["source_name"]) for r in out["logs"]} == {
        ("a", "Alpha"), ("b", "Beta"),
    }
    status = {s["source_id"]: s for s in out["sources"]}
    assert status["bad"] == {
        "source_id": "bad", "source_name": "Bad", "ok": False,
        "error": "source is down", "count": 0, "mode": "search", "truncated": False,
    }
    assert status["slow"]["error"] == "timeout" and status["slow"]["ok"] is False
    # Alpha's connector reported 9 matches for 2 rows: its own read was cut.
    assert status["a"]["truncated"] is True and status["a"]["count"] == 2
    assert status["b"]["mode"] == "buffer" and status["b"]["truncated"] is False
    assert out["truncated"] is True and out["count"] == 2


async def test_fan_out_gives_every_source_its_own_query_copy():
    seen: list[str | None] = []

    async def mutating(sq):
        sq.contains = "tampered"
        return [], 0

    async def observing(sq):
        await asyncio.sleep(0)
        seen.append(sq.contains)
        return [], 0

    out = await log_rows.fan_out(
        [
            log_rows.BrowseTarget("m", "M", "search", mutating),
            log_rows.BrowseTarget("o", "O", "search", observing),
        ],
        log_rows.browse_query(limit=10, query="ssh"),
        per_source_timeout=1.0,
    )
    assert seen == ["ssh"]
    assert out == {"logs": [], "count": 0, "sources": out["sources"], "partial": False,
                   "limit": 10, "truncated": False}


async def test_fan_out_golden_envelope():
    """Pins the exact ``GET /api/logs`` envelope the pre-move route produced for fixed
    readers (rows, totals, a failure and a timeout), independent of the route — the
    route-level pinning lives in ``test_browse_and_connection`` and
    ``test_round4_wave4_routes_monolith``."""

    async def alpha(sq):
        return [_row("2026-10-08T00:00:01+00:00", "a1"), _row("", "a0")], 2

    async def beta(sq):
        return [_row("2026-10-08T00:00:02+00:00", "b1")], None

    async def broken(sq):
        raise ValueError("index_not_found: all-logs-*")

    async def stuck(sq):
        await asyncio.sleep(5)
        return [], None  # pragma: no cover

    out = await log_rows.fan_out(
        [
            log_rows.BrowseTarget("a", "Alpha", "search", alpha),
            log_rows.BrowseTarget("b", "Beta", "buffer", beta),
            log_rows.BrowseTarget("x", "Broken", "search", broken),
            log_rows.BrowseTarget("s", "Stuck", "search", stuck),
        ],
        log_rows.browse_query(limit=3),
        per_source_timeout=0.05,
    )
    assert out == {
        "logs": [
            {"id": "b1", "ts": "2026-10-08T00:00:02+00:00",
             "source_id": "b", "source_name": "Beta"},
            {"id": "a1", "ts": "2026-10-08T00:00:01+00:00",
             "source_id": "a", "source_name": "Alpha"},
            {"id": "a0", "ts": "", "source_id": "a", "source_name": "Alpha"},
        ],
        "count": 3,
        "sources": [
            {"source_id": "a", "source_name": "Alpha", "ok": True, "count": 2,
             "mode": "search", "truncated": False},
            {"source_id": "b", "source_name": "Beta", "ok": True, "count": 1,
             "mode": "buffer", "truncated": False},
            {"source_id": "x", "source_name": "Broken", "ok": False,
             "error": "index_not_found: all-logs-*", "count": 0, "mode": "search",
             "truncated": False},
            {"source_id": "s", "source_name": "Stuck", "ok": False, "error": "timeout",
             "count": 0, "mode": "search", "truncated": False},
        ],
        "partial": True,
        "limit": 3,
        "truncated": False,
    }


async def test_fan_out_clamps_a_caller_supplied_size():
    """The chat tool passes a model-influenced size: the 1..200 cap holds inside the
    shared helper, per source AND on the merge, and the envelope echoes the clamp."""
    sizes: list[int] = []

    async def many(sq):
        sizes.append(sq.size)
        return [_row(f"2026-10-08T00:{i // 60:02d}:{i % 60:02d}+00:00", f"r{i}")
                for i in range(sq.size)], None

    targets = [log_rows.BrowseTarget("a", "A", "buffer", many),
               log_rows.BrowseTarget("b", "B", "buffer", many)]
    out = await log_rows.fan_out(
        targets, StructuredQuery(size=100_000, sort_desc=True), per_source_timeout=1.0,
    )
    assert sizes == [200, 200]
    assert out["limit"] == 200 and out["count"] == 200 and out["truncated"] is True

    sizes.clear()
    out = await log_rows.fan_out(
        targets, StructuredQuery(size=-3, sort_desc=True), per_source_timeout=1.0,
    )
    assert sizes == [1, 1] and out["limit"] == 1 and out["count"] == 1

    # An in-range size is passed through untouched (the route's already-clamped path).
    sizes.clear()
    sq = log_rows.browse_query(limit=7)
    await log_rows.fan_out(targets, sq, per_source_timeout=1.0)
    assert sizes == [7, 7] and sq.size == 7


async def test_fan_out_redacts_errors_to_their_kind_for_chat(caplog):
    """``raw_errors=False`` keeps raw exception text out of anything that can reach a
    prompt or the chat UI (SPEC §5.2); the detail goes to the server log instead."""

    async def broken(sq):
        raise RuntimeError("connect to 10.0.0.5:9200 failed: secret-host")

    async def stuck(sq):
        await asyncio.sleep(5)
        return [], None  # pragma: no cover

    targets = [log_rows.BrowseTarget("x", "X", "search", broken),
               log_rows.BrowseTarget("s", "S", "search", stuck)]
    with caplog.at_level("WARNING", logger="tlsoc.engine.log_rows"):
        out = await log_rows.fan_out(
            targets, log_rows.browse_query(limit=5), per_source_timeout=0.05,
            raw_errors=False,
        )
    assert [(s["source_id"], s["error"]) for s in out["sources"]] == [
        ("x", "error"), ("s", "timeout"),
    ]
    assert "secret-host" not in repr(out)
    assert any("secret-host" in r.getMessage() for r in caplog.records)
    # The default stays the route's historical raw text.
    out = await log_rows.fan_out(targets[:1], log_rows.browse_query(limit=5),
                                 per_source_timeout=0.05)
    assert out["sources"][0]["error"] == "connect to 10.0.0.5:9200 failed: secret-host"


def test_clamps_and_browse_query_match_the_route_contract():
    assert log_rows.clamp_browse_limit(None) == 100
    assert log_rows.clamp_browse_limit(0) == 100
    assert log_rows.clamp_browse_limit(-5) == 1
    assert log_rows.clamp_browse_limit(9999) == 200
    assert log_rows.clamp_per_source_timeout(None) == 8.0
    assert log_rows.clamp_per_source_timeout(0.01) == 0.5
    assert log_rows.clamp_per_source_timeout(99) == 30.0
    sq = log_rows.browse_query(limit=5, query="", time_from="now-1h", time_to="now")
    assert sq == StructuredQuery(contains=None, time_from="now-1h", time_to="now",
                                 size=5, sort_desc=True)


def test_tenant_browse_targets_select_enabled_browsable_sources():
    prefs = _sources_prefs()
    reg = get_registry()
    targets = log_rows.tenant_browse_targets(
        prefs.sources, prefs=prefs, registry=reg,
        es_client_for_source=lambda src: (None, False), ingest_service=None,
    )
    assert [(t.source_id, t.source_name, t.mode) for t in targets] == [
        ("pull-a", "pull-a", "search"), ("push-b", "Hook", "buffer"),
    ]
    scoped = log_rows.tenant_browse_targets(
        prefs.sources, prefs=prefs, registry=reg,
        es_client_for_source=lambda src: (None, False), ingest_service=None,
        source_id="push-b",
    )
    assert [t.source_id for t in scoped] == ["push-b"]


async def test_demo_browse_targets_read_only_their_own_adapters():
    asked: list[str] = []

    class _Adapter:
        async def search(self, prefs, sq):
            return SimpleNamespace(events=[make_raw_event(id="d1")], total=1)

    def _connector(source_id):
        asked.append(source_id)
        return _Adapter() if source_id == "demo-a" else None

    targets = log_rows.demo_browse_targets(
        [{"id": "demo-a", "display_name": "Demo A"}, {"id": "demo-b"}],
        prefs=Preferences(), demo_source_connector=_connector,
    )
    assert [(t.source_id, t.source_name, t.mode) for t in targets] == [
        ("demo-a", "Demo A", "search"), ("demo-b", "demo-b", "search"),
    ]
    out = await log_rows.fan_out(targets, log_rows.browse_query(limit=5), per_source_timeout=1)
    assert [r["id"] for r in out["logs"]] == ["d1"]
    assert {s["source_id"]: s["count"] for s in out["sources"]} == {"demo-a": 1, "demo-b": 0}
    assert asked == ["demo-a", "demo-b"]


async def test_pull_reader_closes_an_owned_client_even_when_the_search_fails():
    closed: list[bool] = []

    class _Client:
        async def close(self):
            closed.append(True)

        async def search_logs(self, *a, **k):
            raise RuntimeError("tls handshake failed")

        async def search(self, *a, **k):
            raise RuntimeError("tls handshake failed")

    src = SourceInstance(id="pull-a", source_type=SourceType.ELASTICSEARCH)
    reader = log_rows.pull_reader(
        src, prefs=Preferences(), es_client_for_source=lambda s: (_Client(), True),
    )
    with pytest.raises(RuntimeError):
        await reader(log_rows.browse_query(limit=5))
    assert closed == [True]


def test_unified_logs_route_matches_a_direct_fan_out(client):
    """The route is now HTTP checks + ``fan_out``; both paths read the same rows."""
    state = client.app.state.tlsoc
    base = to_millis(now_utc()) - 600_000
    seed_logs(state.es, [make_log_event(ip=f"10.9.0.{i}", ts_millis=base + i * 1000)
                         for i in range(4)], index="all-logs-2026.10.08")
    assert client.post("/api/sources", json={
        "id": "elk-a", "source_type": "elasticsearch", "is_primary": True,
        "config": {"data_view_pattern": "all-logs-*"}}).status_code == 200
    assert client.post("/api/sources", json={
        "id": "hook", "source_type": "webhook"}).status_code == 200

    via_route = client.get("/api/logs", params={"limit": 3}).json()

    async def _direct():
        targets = log_rows.tenant_browse_targets(
            state.prefs.sources, prefs=state.prefs, registry=get_registry(),
            es_client_for_source=state.es_client_for_source,
            ingest_service=state.ingest_service,
        )
        return await log_rows.fan_out(
            targets, log_rows.browse_query(limit=3),
            per_source_timeout=8.0,
        )

    direct = client.portal.call(_direct)
    assert via_route == direct
    assert via_route["count"] == 3 and via_route["truncated"] is True
    assert {s["source_id"]: s["mode"] for s in via_route["sources"]} == {
        "elk-a": "search", "hook": "buffer",
    }


# --------------------------------------------------------------------------- #
# views
# --------------------------------------------------------------------------- #
def test_proposal_public_hides_internal_lease_fields():
    proposal = Proposal(kind="memory", payload={"text": "x"}, applying_token="secret-lease",
                        decision_actor="bob")
    out = views.proposal_public(proposal)
    assert "applying_token" not in out and "decision_actor" not in out
    assert out["id"] == proposal.id and out["expired"] is False
    assert isinstance(out["evidence"], dict)


def test_campaign_json_bounds_source_derived_strings():
    long_value = "A" * 5000
    campaign = Campaign(
        id="camp-1", name=long_value, case_ids=["c1", "c2"],
        entities=[CampaignEntity(entity_type="ip", value=long_value)],
        mitre=["T1110"], severity_rollup="high",
    )
    out = views.campaign_json(campaign)
    assert out == routes_campaigns._campaign_json(campaign)
    assert len(out["name"]) == 2000 and len(out["entities"][0]["value"]) == 2000
    assert out["case_count"] == 2 and out["status"] == "open"
    assert out["severity_rollup"] == "high"
    assert views.campaign_json(campaign.model_copy(update={"severity_rollup": None}))[
        "severity_rollup"
    ] is None


def test_log_row_projection_is_unchanged():
    ev = RawEvent(id="e9", source={"message": ["first", "second"]}, timestamp_millis=0,
                  ip="1.2.3.4", rule=None, rule_name="Named rule")
    row = log_rows.log_row(ev)
    assert row == {
        "id": "e9", "ts": "", "source_ip": "1.2.3.4", "user": None, "host": None,
        "rule": "Named rule", "severity": ev.severity, "message": "first",
        "_raw": {"message": ["first", "second"]},
    }
