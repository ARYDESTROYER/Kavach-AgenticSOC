"""Round 4 / Wave 2 — the single-source poller bug fix (PollerManager fan-out).

Historically the poller was wired to ONE ``primary`` PULL source, so every other
enabled PULL source was silently never polled / correlated / triaged. The
:class:`~app.engine.poller_manager.PollerManager` fans the poll cycle out across
EVERY enabled PULL source while preserving byte-identical single-source behaviour.

These tests prove (fully offline — fake ES, no LLM, $0 candidate path):
  * two enabled PULL sources are BOTH polled → both form cases (the bug fix);
  * two UN-FED sources never stomp each other's legacy ``"primary"`` cursor (#4);
  * the 0/1-source single-poll fallback is byte-identical (primary still on ``"primary"``);
  * each per-source connector is built with ``connector_id=src.id`` (per-source gates);
  * each poller honours ITS OWN source's entity strategy;
  * owned per-source clients are tracked + closed on rewire/shutdown (no leak);
  * real pollers stay OFF while demo is active;
  * #1 — a per-source log client can never carry a mgmt key.
"""

from __future__ import annotations

import pytest

from app.config import CorrelationRule, SourceInstance
from app.constants import CorrelationMode, EntityType, IngestMode, SourceType
from app.engine.poller_manager import PollerManager
from app.state import AppState
from app.utils import now_utc, to_millis
from tests.conftest import make_log_event

asyncio = pytest.mark.asyncio


async def _set_threshold(state: AppState, n: int = 3) -> None:
    p = state.prefs.model_copy(deep=True)
    p.default_correlation = CorrelationRule(
        mode=CorrelationMode.THRESHOLD, n=n, window_seconds=3600, group_by=EntityType.IP
    )
    await state.update_prefs(p)


def _source(sid: str, pattern: str, *, primary: bool = False, **cfg) -> SourceInstance:
    """A PULL Elasticsearch source reading a distinct in-memory index pattern (no ES
    connection overrides → it reuses the shared fake ES, filtered by data_view)."""
    return SourceInstance(
        id=sid, source_type=SourceType.ELASTICSEARCH, display_name=sid,
        enabled=True, is_primary=primary,
        config={"data_view_pattern": pattern, **cfg},
    )


def _seed(state: AppState, index: str, ip: str, n: int = 4) -> None:
    base = to_millis(now_utc()) - 60_000
    for i in range(n):
        state.es.add_log(index, make_log_event(ip=ip, ts_millis=base + i * 1000),
                         doc_id=f"{index}-{ip}-{i}")


async def _configure_sources(state: AppState, sources: list[SourceInstance]) -> None:
    prefs = state.prefs.model_copy(deep=True)
    prefs.sources = sources
    await state.update_prefs(prefs)
    state.rebuild_log_source()  # rebuild the fan-out from the new sources


# --------------------------------------------------------------------------- #
# 1. THE BUG FIX — two enabled PULL sources are BOTH polled.
# --------------------------------------------------------------------------- #
@asyncio
async def test_two_pull_sources_are_both_polled_and_form_cases(app_state: AppState):
    await _set_threshold(app_state, 3)
    _seed(app_state, "srcA-logs", "10.0.0.1")   # primary
    _seed(app_state, "srcB-logs", "10.0.0.2")   # non-primary — the one the bug dropped
    await _configure_sources(app_state, [
        _source("srcA", "srcA-logs*", primary=True),
        _source("srcB", "srcB-logs*"),
    ])

    stats = await app_state.poller.poll_once(app_state.prefs)
    # BOTH sources contributed events + a cluster/candidate.
    assert stats["polled"] >= 8
    assert stats["clusters"] >= 2

    cases, total = await app_state.cases.list()
    assert total == 2
    by_source = {c.source_id for c in cases}
    # The non-primary source's events genuinely produced their own case (bug fixed).
    assert by_source == {"srcA", "srcB"}
    by_ip = {c.entity.value for c in cases}
    assert by_ip == {"10.0.0.1", "10.0.0.2"}


# --------------------------------------------------------------------------- #
# 2. Two UN-FED sources do NOT stomp each other's cursor (#4).
# --------------------------------------------------------------------------- #
@asyncio
async def test_two_unfed_sources_do_not_stomp_the_primary_cursor(app_state: AppState):
    await _set_threshold(app_state, 3)
    _seed(app_state, "srcA-logs", "10.1.0.1")
    _seed(app_state, "srcB-logs", "10.1.0.2")
    await _configure_sources(app_state, [
        _source("srcA", "srcA-logs*", primary=True),
        _source("srcB", "srcB-logs*"),
    ])
    await app_state.poller.poll_once(app_state.prefs)

    # The TRUE primary keeps the legacy ``"primary"`` cursor doc (no migration).
    primary_cursor = await app_state.cursor_store.load()
    assert primary_cursor.is_set()
    # The NON-primary un-fed source uses a DISTINCT ``f"{id}:primary"`` key — it did
    # NOT overwrite the shared primary doc (both advanced independently).
    srcb_cursor = await app_state.cursor_store.load_keyed("srcB:primary")
    assert srcb_cursor.is_set()

    # Re-poll: durable cursors mean nothing is re-processed for EITHER source (#4).
    stats2 = await app_state.poller.poll_once(app_state.prefs)
    assert stats2["new"] == 0
    _cases, total = await app_state.cases.list()
    assert total == 2  # no duplicate cases from the second poll


# --------------------------------------------------------------------------- #
# 3. Single-poll fallback (0 / 1 source) — byte-identical to the legacy Poller.
# --------------------------------------------------------------------------- #
@asyncio
async def test_zero_sources_polls_on_legacy_primary_cursor(app_state: AppState):
    # No configured sources (the fixture default) → the fallback ElasticConnector on
    # the legacy ``"primary"`` cursor, exactly as the single Poller did.
    await _set_threshold(app_state, 3)
    base = to_millis(now_utc()) - 60_000
    for i in range(4):
        app_state.es.add_log("all-logs-2026.06.16",
                             make_log_event(ip="10.2.0.1", ts_millis=base + i * 1000),
                             doc_id=f"z{i}")
    stats = await app_state.poller.poll_once(app_state.prefs)
    assert stats["new"] == 4 and stats["clusters"] == 1
    _cases, total = await app_state.cases.list()
    assert total == 1
    # The legacy ``"primary"`` cursor advanced (and no ``:primary`` keyed variant).
    assert (await app_state.cursor_store.load()).is_set()


@asyncio
async def test_single_source_uses_primary_cursor_key(app_state: AppState):
    await _set_threshold(app_state, 3)
    _seed(app_state, "solo-logs", "10.3.0.1")
    await _configure_sources(app_state, [_source("solo", "solo-logs*", primary=True)])
    stats = await app_state.poller.poll_once(app_state.prefs)
    assert stats["clusters"] == 1
    # A single (primary) un-fed source stays on the legacy ``"primary"`` cursor doc —
    # byte-identical, no migration, no ``solo:primary`` collision key.
    assert (await app_state.cursor_store.load()).is_set()
    solo_keyed = await app_state.cursor_store.load_keyed("solo:primary")
    assert not solo_keyed.is_set()


# --------------------------------------------------------------------------- #
# 4. Per-source connector identity + per-source gate (auto_correlate off).
# --------------------------------------------------------------------------- #
@asyncio
async def test_per_source_connector_id_and_auto_correlate_gate(app_state: AppState):
    """Each per-source connector is built with ``connector_id=src.id`` so per-source
    gates are keyed to the right source. srcB has ``auto_correlate=False``; with
    ``background_scan_enabled`` OFF (default) both sources register CANDIDATES — proving
    each cluster is attributed to ITS OWN source (the connector_id wiring) and the
    per-source gate is present on the non-primary child."""
    await _set_threshold(app_state, 3)
    await _configure_sources(app_state, [
        _source("srcA", "srcA-logs*", primary=True),
        _source("srcB", "srcB-logs*", auto_correlate=False),
    ])
    _seed(app_state, "srcA-logs", "10.4.0.1")
    _seed(app_state, "srcB-logs", "10.4.0.2")

    # The manager built srcB's connector with connector_id="srcB" (per-source gates).
    child_ids = {getattr(c._source, "connector_id", None) for c in app_state.poller._children}
    assert "srcB" in child_ids
    # srcB's per-source auto_correlate gate reads False off the right source instance.
    srcb = app_state.prefs.source_by_id("srcB")
    assert srcb is not None and srcb.auto_correlate() is False

    stats = await app_state.poller.poll_once(app_state.prefs)
    # Both sources produced candidate cases attributed to their OWN source_id.
    assert stats["candidates"] >= 2
    cases, _total = await app_state.cases.list()
    assert {c.source_id for c in cases} == {"srcA", "srcB"}


# --------------------------------------------------------------------------- #
# 5. Per-source entity strategy is honored per poller.
# --------------------------------------------------------------------------- #
@asyncio
async def test_per_source_entity_strategy_is_resolved_per_source(app_state: AppState):
    from app.constants import EntityStrategy

    await _configure_sources(app_state, [
        _source("srcA", "srcA-logs*", primary=True, entity_strategy="ip"),
        _source("srcB", "srcB-logs*", entity_strategy="auto"),
    ])
    # Resolve each poller's OWN source and its effective strategy.
    prefs = app_state.prefs
    primary_src = prefs.source_by_id(
        getattr(app_state.poller._primary._source, "connector_id", None)
    )
    assert primary_src is not None and primary_src.id == "srcA"
    assert prefs.entity_strategy_for(primary_src) == EntityStrategy("ip")

    child = app_state.poller._children[0]
    child_src = prefs.source_by_id(getattr(child._source, "connector_id", None))
    assert child_src is not None and child_src.id == "srcB"
    assert prefs.entity_strategy_for(child_src) == EntityStrategy("auto")


# --------------------------------------------------------------------------- #
# 6. Owned per-source clients are tracked + closed on rewire / shutdown.
# --------------------------------------------------------------------------- #
@asyncio
async def test_owned_per_source_clients_are_tracked_and_closed(app_state, monkeypatch):
    """A non-primary source WITH per-source ES overrides yields an OWNED client the
    manager must track and close on rebuild — never leak N connections."""
    closed: list[object] = []

    class _FakeOwned:
        def __init__(self) -> None:
            self.es_mgmt_api_key = "SHOULD-NEVER-BE-SET"  # sentinel; overwritten below

        async def close(self) -> None:
            closed.append(self)

    built: list[_FakeOwned] = []

    def _fake_client_for_source(src):
        if src.id == "srcB":
            c = _FakeOwned()
            built.append(c)
            return c, True   # owned=True → manager must track + close it
        return app_state.es, False

    monkeypatch.setattr(app_state, "es_client_for_source", _fake_client_for_source)
    await _configure_sources(app_state, [
        _source("srcA", "srcA-logs*", primary=True),
        _source("srcB", "srcB-logs*"),
    ])
    assert len(built) == 1
    assert built[0] in app_state.poller._owned_clients  # tracked

    # A rebuild (e.g. another source edit) must schedule the old owned client's close.
    await _configure_sources(app_state, [_source("srcA", "srcA-logs*", primary=True)])
    # Give the scheduled close task a chance to run.
    import asyncio as _aio
    await _aio.sleep(0)
    assert built[0] in closed  # the owned client was closed, not leaked


# --------------------------------------------------------------------------- #
# 7. Real pollers stay OFF while demo is active.
# --------------------------------------------------------------------------- #
@asyncio
async def test_manager_run_loop_is_gated_off_while_demo_active(app_state: AppState, monkeypatch):
    """The manager's ``_run`` loop applies the SAME gate the single Poller did — a
    poll is skipped when demo is active. We drive ONE iteration of the real ``_run``
    loop with demo engaged and assert ``poll_once`` was never called, then flip demo
    off and assert it IS called."""
    await _configure_sources(app_state, [_source("srcA", "srcA-logs*", primary=True)])

    calls = {"n": 0}

    async def _counting(prefs=None):
        calls["n"] += 1
        return {}

    monkeypatch.setattr(app_state.poller, "poll_once", _counting)

    # Make polling eligible EXCEPT demo is engaged (mode != 'off' → active True).
    p = app_state.prefs.model_copy(deep=True)
    p.polling_enabled = True
    p.setup_complete = True
    p.demo.mode = "seeded"  # demo engaged → active
    app_state.prefs = p
    assert app_state.prefs.demo.active is True

    # One real _run iteration: monkeypatch asyncio.sleep to cancel the loop after the
    # gate check so we test exactly one pass.
    import asyncio as _aio

    async def _stop_sleep(_secs):
        raise _aio.CancelledError

    monkeypatch.setattr(_aio, "sleep", _stop_sleep)
    with pytest.raises(_aio.CancelledError):
        await app_state.poller._run()
    assert calls["n"] == 0  # demo blocked the real poll

    # Flip demo OFF and run one more iteration — now the poll fires.
    p2 = app_state.prefs.model_copy(deep=True)
    p2.demo.mode = "off"
    app_state.prefs = p2
    with pytest.raises(_aio.CancelledError):
        await app_state.poller._run()
    assert calls["n"] == 1  # real poll ran once demo was off


# --------------------------------------------------------------------------- #
# 8. #1 — a per-source log client can NEVER carry a mgmt key.
# --------------------------------------------------------------------------- #
@asyncio
async def test_per_source_client_never_carries_mgmt_key(app_state: AppState):
    """``es_client_for_source`` (the ONLY path the manager builds per-source clients
    with) forces ``es_mgmt_api_key=None`` (#1). Verify a source carrying its own ES
    URL + read key yields a client whose secrets have no mgmt key."""
    src = SourceInstance(
        id="srcSecure", source_type=SourceType.ELASTICSEARCH,
        config={"es_url": "https://es.example:9200", "es_api_key": "ro-key-only",
                "es_verify_certs": False, "data_view_pattern": "sec-*"},
    )
    client, owned = app_state.es_client_for_source(src)
    assert owned is True
    # The per-source client's Secrets must never carry a management key (#1).
    secrets = getattr(client, "_secrets", None) or getattr(client, "secrets", None)
    assert secrets is not None
    assert getattr(secrets, "es_mgmt_api_key", "sentinel") in (None, "")


# --------------------------------------------------------------------------- #
# 9. ingest_mode==PULL is honored even if the class check were to disagree.
# --------------------------------------------------------------------------- #
@asyncio
async def test_pull_enumeration_skips_receivers_and_disabled(app_state: AppState):
    from app.constants import SourceType as ST

    prefs = app_state.prefs.model_copy(deep=True)
    prefs.sources = [
        _source("srcA", "srcA-logs*", primary=True),
        SourceInstance(id="wh", source_type=ST.WEBHOOK, enabled=True,
                       ingest_mode=IngestMode.PUSH_HTTP, config={}),
        _source("srcDisabled", "x-*"),
    ]
    prefs.sources[-1].enabled = False
    await app_state.update_prefs(prefs)
    mgr = PollerManager(app_state)
    pulls = {s.id for s in mgr._pull_sources(app_state.prefs)}
    # Receiver (webhook) + the disabled source are excluded; only the PULL source.
    assert pulls == {"srcA"}
    await mgr.stop()


@asyncio
async def test_drain_headroom_uses_one_global_fanout_allowance(app_state: AppState, monkeypatch):
    # The configured cap belongs to the WHOLE manager tick. A busy source that reports the
    # full allowance leaves no second cap for an idle sibling's deferred drain.
    mgr = app_state.poller
    captured: dict = {}

    async def fake_drain(prefs, *, older_than, limit):
        captured["limit"] = limit
        return 0

    monkeypatch.setattr(mgr, "_drain_deferred", fake_drain)

    class _FakeSource:
        connector_id = "s"

    class _FakePoller:
        def __init__(self, inv: int) -> None:
            self._inv = inv
            self._source = _FakeSource()

        async def poll_once(self, prefs):
            return {"investigated": self._inv}

    cap = 25
    p = app_state.prefs.model_copy(deep=True)
    p.caps.max_auto_investigations_per_tick = cap
    monkeypatch.setattr(mgr, "_all_pollers", lambda: [_FakePoller(cap), _FakePoller(0)])
    await mgr._poll_once_locked(p)
    assert captured["limit"] == 0


@asyncio
async def test_drain_scan_filters_to_open_cases(app_state: AppState, monkeypatch):
    # audit #31: the deferred-candidate drain must query only OPEN cases, so it never
    # deep-paginates oldest-first through the CLOSED/RESOLVED bulk. Round 16 B11: it
    # asks the store for the deferred queue itself, once per tick (twice the allowance,
    # at least 50), and never pages the OPEN listing.
    mgr = app_state.poller
    asked: list = []

    async def fake_deferred(*, older_than, limit):
        asked.append((older_than, limit))
        return []

    async def no_list(**_kwargs):
        raise AssertionError("the drain must not page every OPEN case")

    monkeypatch.setattr(mgr._state.real_cases, "list_deferred_candidates", fake_deferred)
    monkeypatch.setattr(mgr._state.real_cases, "list", no_list)
    p = app_state.prefs.model_copy(deep=True)
    p.background_scan_enabled = True
    p.caps.kill_switch = False
    await mgr._drain_deferred(p, older_than="2000-01-01T00:00:00Z", limit=5)
    assert asked == [("2000-01-01T00:00:00Z", 50)]
    await mgr._drain_deferred(p, older_than="2000-01-01T00:00:00Z", limit=40)
    assert asked[-1] == ("2000-01-01T00:00:00Z", 80)


async def test_the_deferred_query_filters_open_undecided_deferred_cases(app_state: AppState):
    """The Elasticsearch deferred query itself: OPEN, no verdict, not acted on by a
    person, the ``deferred:`` prefix, updated before the tick, oldest created first."""
    from app.stores.cases import CaseStore

    seen: list = []

    class _Recorder:
        async def search(self, index, body):
            seen.append(body)
            return {"hits": {"hits": []}}

    await CaseStore(_Recorder()).list_deferred_candidates(older_than="2026-11-01T00:00:00Z", limit=7)
    (body,) = seen
    filters = body["query"]["bool"]["filter"]
    assert {"term": {"status": "open"}} in filters
    assert {"range": {"updated_at": {"lt": "2026-11-01T00:00:00Z"}}} in filters
    assert body["query"]["bool"]["must_not"] == [
        {"exists": {"field": "verdict"}},
        {"term": {"decision_by": "analyst"}},
    ]
    assert body["size"] == 7 and body["sort"][0] == {"created_at": {"order": "asc"}}
    assert "from" not in body
