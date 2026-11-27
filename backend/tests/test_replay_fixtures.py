"""Forward fixture capture: hard bounds, whole-fixture skips, and strict loading."""

from __future__ import annotations

import copy
import json
from typing import Any

import pytest

from app.api.routes_jobs import _contains_sensitive
from app.constants import (
    REPLAY_FIXTURE_SLOT_PREFIX,
    REPLAY_FIXTURES_KEY,
    REPLAY_FIXTURES_NS,
    SourceSurface,
)
from app.engine.replay.fixtures import (
    RING_SIZE_MAX,
    build_fixture,
    canonical_json,
    derive_raw_hits,
    source_field_mapping,
)

from tests.replay_support import capture, capture_candidate, make_cluster


class _CountingKV:
    """A KV proxy that records every write, so an absence assertion is not vacuous."""

    def __init__(self, inner: Any) -> None:
        self._inner = inner
        self.puts: list[tuple[str, str]] = []

    async def get(self, namespace: str, key: str):
        return await self._inner.get(namespace, key)

    async def put(self, namespace: str, key: str, value: dict) -> None:
        self.puts.append((namespace, key))
        await self._inner.put(namespace, key, value)

    async def put_if(self, namespace: str, key: str, value: dict, expected_rev: int) -> bool:
        self.puts.append((namespace, key))
        return await self._inner.put_if(namespace, key, value, expected_rev)


async def _set_capture(state, **updates):
    prefs = state.prefs.model_copy(
        update={"replay_capture": state.prefs.replay_capture.model_copy(update=updates)}
    )
    await state.update_prefs(prefs)


@pytest.mark.asyncio
async def test_capture_ring_is_hard_bounded_and_reuses_slots(app_state):
    await _set_capture(app_state, ring_size=4)
    ids = [await capture(app_state, ip=f"203.0.113.{index}") for index in range(9)]
    doc = await app_state.replay_fixtures.catalog()
    assert len(doc["entries"]) == 4
    assert doc["next_seq"] == 9
    slots = sorted(entry["slot"] for entry in doc["entries"])
    assert slots == [0, 1, 2, 3]
    kept = {entry["fixture_id"] for entry in doc["entries"]}
    assert kept == set(ids[-4:])
    for stale in ids[:5]:
        assert await app_state.replay_fixtures.load(stale) is None
    cfg = app_state.prefs.replay_capture
    assert await app_state.replay_fixtures.stored_bytes() <= (
        cfg.ring_size * cfg.max_fixture_bytes
    )


@pytest.mark.asyncio
async def test_oversize_and_overlong_fixtures_are_skipped_whole(app_state):
    """Never truncated and never sampled: either would change the replayed evidence."""
    await _set_capture(app_state, max_events_per_fixture=2)
    cluster = make_cluster(ip="198.51.100.7", events=5)
    await app_state.replay_fixtures.sink(capture_candidate(cluster, app_state.prefs))
    doc = await app_state.replay_fixtures.catalog()
    assert doc["entries"] == []
    assert doc["skipped_too_many_events"] == 1

    await _set_capture(app_state, max_events_per_fixture=50, max_fixture_bytes=4096)
    fat = make_cluster(ip="198.51.100.8", events=6)
    for event in fat.member_events:
        event.source["padding"] = "x" * 4096
    await app_state.replay_fixtures.sink(capture_candidate(fat, app_state.prefs))
    doc = await app_state.replay_fixtures.catalog()
    assert doc["entries"] == []
    assert doc["skipped_oversize"] == 1


@pytest.mark.asyncio
async def test_capture_dedups_by_content_hash(app_state):
    cluster = make_cluster(ip="198.51.100.9")
    candidate = capture_candidate(cluster, app_state.prefs)
    await app_state.replay_fixtures.sink(candidate)
    await app_state.replay_fixtures.sink(copy.deepcopy(candidate))
    doc = await app_state.replay_fixtures.catalog()
    assert len(doc["entries"]) == 1
    assert doc["next_seq"] == 1


@pytest.mark.asyncio
async def test_capture_disabled_writes_nothing(app_state):
    counting = _CountingKV(app_state.replay_fixtures._kv)
    app_state.replay_fixtures._kv = counting
    await _set_capture(app_state, enabled=False)
    app_state.replay_fixtures._kv = counting  # survive the prefs rewire
    cluster = make_cluster(ip="198.51.100.10")
    await app_state.replay_fixtures.sink(capture_candidate(cluster, app_state.prefs))
    assert counting.puts == []


@pytest.mark.asyncio
async def test_capture_failure_cannot_affect_the_case(app_state):
    """A raising sink must leave the investigation byte-identical to no sink at all."""
    async def explode(_candidate):
        raise RuntimeError("sink is down")

    pipeline = app_state._real_pipeline
    baseline = await pipeline.investigate_cluster(
        make_cluster(ip="198.51.100.11"), SourceSurface.AUTOMATED_SCAN, app_state.prefs
    )
    pipeline._fixture_sink = explode
    try:
        degraded = await pipeline.investigate_cluster(
            make_cluster(ip="198.51.100.12"), SourceSurface.AUTOMATED_SCAN, app_state.prefs
        )
    finally:
        pipeline._fixture_sink = app_state.replay_fixtures.sink
    assert baseline.error is None and degraded.error is None
    assert degraded.verdict == baseline.verdict
    assert degraded.status == baseline.status
    assert degraded.risk_score == baseline.risk_score


@pytest.mark.asyncio
async def test_body_hash_mismatch_is_unavailable_not_substituted(app_state):
    fixture_id = await capture(app_state, ip="198.51.100.13")
    assert await app_state.replay_fixtures.load(fixture_id) is not None
    doc = await app_state.replay_fixtures.catalog()
    slot = int(doc["entries"][0]["slot"])
    key = f"{REPLAY_FIXTURE_SLOT_PREFIX}{slot:04d}"
    body = await app_state.replay_fixtures._kv.get(REPLAY_FIXTURES_NS, key)
    payload = json.loads(body["body_json"])
    payload["cluster"]["count"] = int(payload["cluster"]["count"]) + 1
    body["body_json"] = canonical_json(payload)
    await app_state.replay_fixtures._kv.put(REPLAY_FIXTURES_NS, key, body)
    assert await app_state.replay_fixtures.load(fixture_id) is None


@pytest.mark.asyncio
async def test_a_fixture_carries_no_secret_shaped_key(app_state):
    cluster = make_cluster(ip="198.51.100.14")
    body = build_fixture(capture_candidate(cluster, app_state.prefs))
    assert _contains_sensitive(body) is False


@pytest.mark.asyncio
async def test_purge_clears_the_catalog_and_overwrites_every_body(app_state):
    ids = [await capture(app_state, ip=f"198.51.100.{20 + i}") for i in range(3)]
    removed = await app_state.replay_fixtures.clear()
    assert removed == 3
    doc = await app_state.replay_fixtures.catalog()
    assert doc["entries"] == []
    for slot in range(3):
        key = f"{REPLAY_FIXTURE_SLOT_PREFIX}{slot:04d}"
        body = await app_state.replay_fixtures._kv.get(REPLAY_FIXTURES_NS, key)
        assert not body.get("fixture_id")
    for fixture_id in ids:
        assert await app_state.replay_fixtures.load(fixture_id) is None


@pytest.mark.asyncio
async def test_catalog_holds_identity_only_never_log_content(app_state):
    await capture(app_state, ip="198.51.100.30")
    raw = await app_state.replay_fixtures._kv.get(REPLAY_FIXTURES_NS, REPLAY_FIXTURES_KEY)
    entry = raw["entries"][0]
    assert set(entry) == {
        "fixture_id", "content_hash", "slot", "captured_at_millis",
        "capture_app_version", "capture_build_sha", "origin_case_id",
        "source_surface", "event_count", "bytes", "entity_type", "rule_count",
    }


async def _occupied_slots(state, upto: int = RING_SIZE_MAX) -> dict[int, dict]:
    """Read body slots STRAIGHT off the KV, bypassing the catalog.

    Every catalog-derived view (``catalog``, ``stored_bytes``, ``load``, the API's
    ring block) reports orphaned bodies as absent, so an assertion built on any of
    them would pass against the exact defect these tests exist to catch.
    """
    found: dict[int, dict] = {}
    for slot in range(upto):
        key = f"{REPLAY_FIXTURE_SLOT_PREFIX}{slot:04d}"
        body = await state.replay_fixtures._kv.get(REPLAY_FIXTURES_NS, key)
        if isinstance(body, dict) and body.get("fixture_id"):
            found[slot] = body
    return found


@pytest.mark.asyncio
async def test_shrinking_the_ring_scrubs_the_bodies_it_orphans(app_state):
    """Lowering retention must DELETE the old raw records, not strand them forever."""
    await _set_capture(app_state, ring_size=5)
    for index in range(5):
        await capture(app_state, ip=f"198.51.100.{40 + index}")
    assert sorted(await _occupied_slots(app_state)) == [0, 1, 2, 3, 4]

    await _set_capture(app_state, ring_size=2)
    await capture(app_state, ip="198.51.100.60")

    # The invariant: no body exists that the catalog does not name. A slot the ring
    # can no longer address (because ``ring_size`` was lowered) would otherwise never
    # be written or purged again, and its raw records would be resident forever.
    doc = await app_state.replay_fixtures.catalog()
    named = {int(entry["slot"]) for entry in doc["entries"]}
    on_disk = await _occupied_slots(app_state)
    assert set(on_disk) == named
    assert len(on_disk) <= 2

    cfg = app_state.prefs.replay_capture
    stored = sum(
        len(canonical_json(body).encode("utf-8")) for body in on_disk.values()
    )
    assert stored <= cfg.ring_size * cfg.max_fixture_bytes

    # A slot that was still catalogued but is now outside the addressable ring is
    # scrubbed as soon as the catalog stops naming it.
    for index in range(2):
        await capture(app_state, ip=f"198.51.100.{62 + index}")
    assert sorted(await _occupied_slots(app_state)) == [0, 1]


@pytest.mark.asyncio
async def test_purge_removes_bodies_orphaned_by_an_earlier_shrink(app_state):
    """The documented on-demand purge must be exhaustive, not catalog-shaped."""
    await _set_capture(app_state, ring_size=5)
    for index in range(5):
        await capture(app_state, ip=f"198.51.100.{70 + index}")
    # Strand the high slots the way a shrink WITHOUT a following capture does, by
    # trimming the catalog directly — the state an already-shrunk deployment is in.
    raw = await app_state.replay_fixtures._kv.get(REPLAY_FIXTURES_NS, REPLAY_FIXTURES_KEY)
    raw["entries"] = [entry for entry in raw["entries"] if int(entry["slot"]) < 2]
    await app_state.replay_fixtures._kv.put(REPLAY_FIXTURES_NS, REPLAY_FIXTURES_KEY, raw)
    await _set_capture(app_state, ring_size=2)
    assert sorted(await _occupied_slots(app_state)) == [0, 1, 2, 3, 4]

    removed = await app_state.replay_fixtures.clear()

    assert removed == 2
    assert await _occupied_slots(app_state) == {}


@pytest.mark.asyncio
async def test_purge_sweeps_the_whole_slot_space_for_a_capacity_less_catalog(app_state):
    """A catalog with no high-water mark cannot say how far its ring reached."""
    await _set_capture(app_state, ring_size=5)
    for index in range(3):
        await capture(app_state, ip=f"198.51.100.{90 + index}")
    raw = await app_state.replay_fixtures._kv.get(REPLAY_FIXTURES_NS, REPLAY_FIXTURES_KEY)
    raw.pop("ring_capacity", None)
    raw["entries"] = raw["entries"][:1]
    await app_state.replay_fixtures._kv.put(REPLAY_FIXTURES_NS, REPLAY_FIXTURES_KEY, raw)

    await app_state.replay_fixtures.clear()

    assert await _occupied_slots(app_state) == {}


@pytest.mark.asyncio
async def test_a_cases_reset_purges_frozen_fixtures_and_their_raw_records(app_state):
    """A fixture holds MORE log content than the Case it came from (finding: reset)."""
    from app.constants import ResetScope
    from app.engine.reset import reset_service

    fixture_id = await capture(app_state, ip="198.51.100.77")
    before = await _occupied_slots(app_state)
    assert before, "positive control: a body must exist before the reset"
    assert any(
        "198.51.100.77" in canonical_json(body) for body in before.values()
    ), "positive control: the raw record must be readable before the reset"

    receipt = await reset_service(app_state, ResetScope.CASES)

    assert any(str(row).startswith("kv:replay_fixtures") for row in receipt["cleared"])
    assert await app_state.replay_fixtures.load(fixture_id) is None
    assert await _occupied_slots(app_state) == {}


@pytest.mark.asyncio
async def test_a_stored_body_creates_one_field_path_whatever_the_log_names(app_state):
    """Attacker-named log fields must never become KV document FIELD names.

    The shared KV document space is dynamically mapped on the Elasticsearch state
    backend, so a record carrying a thousand distinct field names would otherwise
    consume that index's field budget — or collide on type with another source.
    """
    cluster = make_cluster(ip="198.51.100.101", events=1)
    cluster.member_events[0].source["attacker-chosen-field-name"] = "payload"
    body = build_fixture(capture_candidate(cluster, app_state.prefs))

    def _paths(value, prefix=""):
        if isinstance(value, dict):
            for key, item in value.items():
                yield from _paths(item, f"{prefix}.{key}" if prefix else str(key))
        elif isinstance(value, list):
            for item in value:
                yield from _paths(item, prefix)
        else:
            yield prefix

    paths = set(_paths(body))
    assert not any("attacker-chosen-field-name" in path for path in paths)
    assert "body_json" in paths
    assert "attacker-chosen-field-name" in body["body_json"]


@pytest.mark.asyncio
async def test_raw_hits_are_derived_at_load_not_stored_twice(app_state):
    """Storing the derived log surface would halve the evidence a fixture may hold."""
    cluster = make_cluster(ip="198.51.100.102", events=4)
    body = build_fixture(capture_candidate(cluster, app_state.prefs))
    assert "raw_hits" not in body
    assert "raw_hits" not in body["body_json"]

    from app.engine.replay.fixtures import LoadedFixture

    loaded = LoadedFixture(body)
    assert loaded.raw_hits == derive_raw_hits(loaded.cluster_json)
    assert len(loaded.raw_hits) == 4
    assert loaded.raw_hits[0]["_source"] == cluster.member_events[0].source


@pytest.mark.asyncio
async def test_a_fixture_whose_stored_body_fits_but_whose_double_would_not(app_state):
    """The byte cap measures the fixture, not the fixture plus a copy of itself."""
    await _set_capture(app_state, max_fixture_bytes=8192, max_events_per_fixture=50)
    cluster = make_cluster(ip="198.51.100.103", events=4)
    for event in cluster.member_events:
        event.source["detail"] = "d" * 700
    body = build_fixture(capture_candidate(cluster, app_state.prefs))
    size = len(canonical_json(body).encode("utf-8"))
    doubled = size + len(canonical_json(derive_raw_hits(dict(
        cluster.model_dump(mode="json")
    ))).encode("utf-8"))
    assert size <= 8192 < doubled

    await app_state.replay_fixtures.sink(capture_candidate(cluster, app_state.prefs))
    doc = await app_state.replay_fixtures.catalog()
    assert doc["skipped_oversize"] == 0
    assert len(doc["entries"]) == 1


@pytest.mark.asyncio
async def test_the_capturing_sources_field_mapping_travels_with_the_fixture(app_state):
    """A non-ECS source's overlay must be captured, or every replay reads ECS."""
    from app.config import SourceInstance
    from app.constants import SourceType

    source = SourceInstance(
        id="wz", source_type=SourceType.WAZUH, is_primary=True,
        config={
            "time_field": "timestamp",
            "source_ip_field": "data.srcip",
            "host_field": "agent.name",
            "field_mappings_extra": {"user_field": "data.dstuser"},
        },
    )
    prefs = app_state.prefs.model_copy(update={"sources": [source]})

    mapping = source_field_mapping(prefs, ["wz"])
    assert mapping["status"] == "resolved"
    assert mapping["overrides"]["time_field"] == "timestamp"
    assert mapping["overrides"]["source_ip_field"] == "data.srcip"
    assert mapping["overrides"]["user_field"] == "data.dstuser"

    # An unconfigured deployment resolves to an EMPTY overlay — global defaults are
    # the right answer there, and "unknown" would wrongly disqualify every fixture.
    assert source_field_mapping(app_state.prefs, ["anything"]) == {
        "status": "resolved", "source_ids": [], "conflicting_keys": [], "overrides": {},
    }


@pytest.mark.asyncio
async def test_sources_that_disagree_on_a_mapping_are_not_captured(app_state):
    """One frozen connector cannot reproduce two conflicting overlays."""
    from app.config import SourceInstance
    from app.constants import SourceType

    prefs = app_state.prefs.model_copy(update={"sources": [
        SourceInstance(id="one", source_type=SourceType.ELASTICSEARCH,
                       config={"time_field": "timestamp"}),
        SourceInstance(id="two", source_type=SourceType.WAZUH,
                       config={"time_field": "@timestamp"}),
    ]})
    mapping = source_field_mapping(prefs, ["one", "two"])
    assert mapping["status"] == "conflict"
    assert mapping["conflicting_keys"] == ["time_field"]
    assert mapping["overrides"] == {}

    candidate = capture_candidate(make_cluster(ip="198.51.100.104"), app_state.prefs)
    candidate["field_mapping"] = mapping
    await app_state.replay_fixtures.sink(candidate)
    doc = await app_state.replay_fixtures.catalog()
    assert doc["entries"] == []
    assert doc["skipped_mapping_conflict"] == 1
