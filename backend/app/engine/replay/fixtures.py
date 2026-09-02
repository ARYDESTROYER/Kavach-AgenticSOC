"""Frozen investigation fixtures — capture, storage and strict-hash loading.

A fixture is the complete, model-independent input to one investigation: the cluster
(with every member event's raw record), the enrichment result that produced its risk
score, the RESOLVED evidence projection in force at capture time, and the capturing
source's effective FIELD MAPPING. It is captured after deterministic risk and BEFORE
any model call, so it can never encode the outcome a later replay is meant to measure.

Storage is a CATALOG document plus a FIXED-SIZE ring of body slots over the shared KV
(:data:`app.constants.REPLAY_FIXTURES_NS`) — no new index, table, or migration. A
fixed slot ring rather than one key per fixture because :class:`KVStore` has no delete
primitive; slot ``seq % ring_size`` is simply overwritten.

Two properties make the storage bound real rather than aspirational:

* every slot the catalog stops naming is SCRUBBED at the moment it is evicted — an
  operator who LOWERS ``ring_size`` would otherwise strand the bodies above the new
  ring, unreachable to both the ring and the purge, forever;
* :meth:`ReplayFixtureStore.clear` sweeps the whole slot space this catalog has ever
  addressed (its ``ring_capacity`` high-water mark), not merely the slots it still
  names, so the operator purge is exhaustive by construction.

The body's log-bearing sections are stored as ONE opaque canonical-JSON string
(``body_json``) rather than as nested objects. The shared KV document space is
dynamically mapped on the Elasticsearch state backend, so storing attacker-named log
field paths as document field NAMES would let one heterogeneous record consume that
index's field budget, or collide on type with another source's record. One string
field per body can do neither. (Dynamic-mapping growth of that shared index from the
existing Round-3/4 KV stores is a separate, pre-existing condition this does not fix;
see ``docs/development/replay-harness.md``.)

The write is two KV operations and is self-healing rather than transactional: the
catalog entry lands first, then the body. If the body write fails the entry points at a
stale slot, so EVERY read re-hashes the body against the catalog's ``content_hash`` and
reports a mismatch as UNAVAILABLE. A fixture is never silently substituted.

Fixture bodies hold raw log records — attacker-influenceable, unfenced data. No API
returns one; the only place a fixture may be rendered is inside a fenced prompt through
the production ``render_cluster`` path (#9).
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from typing import Any, Callable

from ...build_identity import current_record_provenance
from ...constants import (
    REPLAY_FIXTURE_SLOT_PREFIX,
    REPLAY_FIXTURES_KEY,
    REPLAY_FIXTURES_NS,
)
from ...models import Cluster, EnrichmentResult
from ...stores.base import KVStore, kv_mutate
from ...utils import now_utc, to_millis

logger = logging.getLogger("tlsoc.engine.replay.fixtures")

SCHEMA_VERSION = 2

# The schema ceiling on ``ReplayCaptureConfig.ring_size``. Referenced rather than
# spelled as a literal so the purge sweep and the validator cannot drift apart.
RING_SIZE_MAX = 500

# The keys of the fixture CONTENT payload that are hashed into ``content_hash``.
# Capture-time metadata (when, which build, which case) is deliberately excluded: two
# captures of the same cluster content are the same fixture and must dedup to one slot.
_CONTENT_KEYS = (
    "cluster",
    "enrichment",
    "evidence_fields",
    "evidence_max_chars",
    "field_mapping",
)

# The per-source overlay keys a replay must reproduce, so the investigator's log-read
# tool resolves the SAME fields against the frozen records that production resolved
# against the live ones. ``data_view_pattern`` is excluded (the replay's index list is
# derived from the fixture's own records) and so are the evidence keys (they are
# already captured RESOLVED, and must not be re-overridden by a later operator edit).
_MAPPING_OVERLAY_KEYS = (
    "time_field",
    "source_ip_field",
    "user_field",
    "host_field",
    "rule_field",
    "rule_name_field",
    "severity_field",
    "message_field",
    "entity_strategy",
    "severity_threshold",
    "in_scope_rules",
    "excluded_rules",
)


def canonical_json(value: Any) -> str:
    """The one canonical serialisation used for every hash in the harness."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def content_hash_of(payload: dict[str, Any]) -> str:
    """Hash the fixture's CONTENT payload (the decoded ``body_json``)."""
    material = {key: payload.get(key) for key in _CONTENT_KEYS}
    return hashlib.sha256(canonical_json(material).encode("utf-8")).hexdigest()


def derive_raw_hits(cluster: dict[str, Any]) -> list[dict[str, Any]]:
    """The frozen log surface, derived from the cluster's own member events.

    Never persisted: it is a pure function of ``cluster``, so storing it would
    duplicate every raw record inside the per-fixture byte cap — halving the evidence a
    fixture may hold before it is skipped whole — and would be the only way the frozen
    log source and the cluster could ever disagree about what a record contained.
    """
    return [
        {
            "_id": str(event.get("id") or ""),
            "_index": str(event.get("index") or ""),
            "_source": dict(event.get("source") or {}),
        }
        for event in (cluster.get("member_events") or [])
        if isinstance(event, dict)
    ]


def source_field_mapping(prefs: Any, source_ids: list[str]) -> dict[str, Any]:
    """The effective per-source field-mapping overlay for a cluster's sources.

    Resolved generically from ``Preferences.sources`` rather than from any one
    connector class, so a push/queue receiver's overlay is captured exactly like a pull
    connector's. Precedence mirrors the connectors: ``config["field_mappings_extra"]``
    over the top-level ``config`` key, and anything unset simply inherits the global
    Preferences — which is why an unconfigured deployment resolves to an EMPTY overlay
    rather than to "unknown".

    A cluster whose sources DISAGREE on a mapping key has no single faithful replay
    surface (production applied each connector's own overlay while normalising; one
    frozen connector cannot). Such a candidate is reported ``conflict`` and is not
    captured, rather than captured and silently replayed against the wrong fields.
    """
    resolved: list[str] = []
    values: dict[str, list[Any]] = {}
    for source_id in source_ids:
        instance = next(
            (
                source
                for source in (getattr(prefs, "sources", None) or [])
                if str(getattr(source, "id", "")) == str(source_id)
            ),
            None,
        )
        if instance is None:
            continue
        resolved.append(str(source_id))
        config = dict(getattr(instance, "config", None) or {})
        extra = config.get("field_mappings_extra")
        extra = dict(extra) if isinstance(extra, dict) else {}
        for key in _MAPPING_OVERLAY_KEYS:
            value = extra.get(key)
            if value in (None, ""):
                value = config.get(key)
            if value in (None, ""):
                continue
            values.setdefault(key, []).append(value)
    overrides: dict[str, Any] = {}
    conflicts: list[str] = []
    for key, seen in sorted(values.items()):
        distinct = {canonical_json(value) for value in seen}
        if len(distinct) > 1:
            conflicts.append(key)
            continue
        overrides[key] = json.loads(canonical_json(seen[0]))
    return {
        "status": "conflict" if conflicts else "resolved",
        "source_ids": sorted(set(resolved)),
        "conflicting_keys": sorted(conflicts),
        "overrides": {} if conflicts else overrides,
    }


def build_fixture(candidate: dict[str, Any]) -> dict[str, Any]:
    """Turn a capture-sink candidate into a complete, hashed fixture document.

    The log-bearing half is serialised into ONE opaque ``body_json`` string, so a
    fixture contributes exactly one field path to the shared KV document space no
    matter what field names the captured records carry.
    """
    cluster = dict(candidate.get("cluster") or {})
    mapping = candidate.get("field_mapping")
    payload: dict[str, Any] = {
        "cluster": cluster,
        "enrichment": candidate.get("enrichment"),
        "evidence_fields": list(candidate.get("evidence_fields") or []),
        "evidence_max_chars": int(candidate.get("evidence_max_chars") or 0),
        "field_mapping": dict(mapping) if isinstance(mapping, dict) else None,
    }
    digest = content_hash_of(payload)
    return {
        "schema_version": SCHEMA_VERSION,
        "captured_at_millis": to_millis(now_utc()),
        **{
            f"capture_{key}": value
            for key, value in current_record_provenance().items()
        },
        "origin_case_id": str(candidate.get("origin_case_id") or ""),
        "source_surface": str(candidate.get("source_surface") or ""),
        "content_hash": digest,
        "fixture_id": f"fx-{digest[:32]}",
        "body_json": canonical_json(payload),
    }


def payload_of(body: dict[str, Any]) -> dict[str, Any] | None:
    """Decode a stored body's opaque content payload, or ``None`` when unusable."""
    raw = body.get("body_json")
    if not isinstance(raw, str):
        return None
    try:
        payload = json.loads(raw)
    except (TypeError, ValueError):
        return None
    return payload if isinstance(payload, dict) else None


def _catalog_entry(
    body: dict[str, Any], payload: dict[str, Any], slot: int, size: int
) -> dict[str, Any]:
    """The catalog projection of one fixture: identity and shape, NEVER log content."""
    cluster = dict(payload.get("cluster") or {})
    entity = dict(cluster.get("entity") or {})
    return {
        "fixture_id": body["fixture_id"],
        "content_hash": body["content_hash"],
        "slot": int(slot),
        "captured_at_millis": int(body.get("captured_at_millis") or 0),
        "capture_app_version": str(body.get("capture_app_version") or ""),
        "capture_build_sha": str(body.get("capture_build_sha") or ""),
        "origin_case_id": str(body.get("origin_case_id") or ""),
        "source_surface": str(body.get("source_surface") or ""),
        "event_count": len(list(cluster.get("member_events") or [])),
        "bytes": int(size),
        "entity_type": str(entity.get("type") or ""),
        "rule_count": len(list(cluster.get("rule_values") or [])),
    }


class LoadedFixture:
    """One verified fixture, rebuilt fresh for exactly one replay cell.

    ``Cluster`` objects are rebuilt per cell rather than shared: ``investigate_cluster``
    mutates ``risk_score``/``risk_breakdown`` in place, so a shared object would leak
    one cell's state into the next.
    """

    def __init__(self, body: dict[str, Any]) -> None:
        payload = payload_of(body)
        if payload is None:
            raise ValueError("replay fixture body carries no decodable content payload")
        self._body = body
        self._payload = payload
        self.fixture_id: str = str(body["fixture_id"])
        self.content_hash: str = str(body["content_hash"])
        self.captured_at_millis: int = int(body.get("captured_at_millis") or 0)
        self.evidence_fields: tuple[str, ...] = tuple(
            str(f) for f in (payload.get("evidence_fields") or [])
        )
        self.evidence_max_chars: int = int(payload.get("evidence_max_chars") or 0)
        self.origin_case_id: str = str(body.get("origin_case_id") or "")
        self.source_surface: str = str(body.get("source_surface") or "")
        mapping = payload.get("field_mapping")
        self.field_mapping: dict[str, Any] = (
            dict(mapping) if isinstance(mapping, dict) else {}
        )
        # Derived, never stored: see :func:`derive_raw_hits`.
        self.raw_hits: list[dict[str, Any]] = derive_raw_hits(self.cluster_json)

    @property
    def mapping_overrides(self) -> dict[str, Any]:
        """The capturing source's overlay, applied to both prefs and the log source."""
        overrides = self.field_mapping.get("overrides")
        return dict(overrides) if isinstance(overrides, dict) else {}

    @property
    def cluster_json(self) -> dict[str, Any]:
        return dict(self._payload.get("cluster") or {})

    @property
    def enrichment_json(self) -> dict[str, Any] | None:
        raw = self._payload.get("enrichment")
        return dict(raw) if isinstance(raw, dict) else None

    def cluster(self) -> Cluster:
        return Cluster.model_validate(self.cluster_json)

    def enrichment(self) -> EnrichmentResult | None:
        raw = self.enrichment_json
        return EnrichmentResult.model_validate(raw) if raw is not None else None


class ReplayFixtureStore:
    """The bounded fixture catalog + body ring over the shared KV."""

    def __init__(self, kv: KVStore, get_prefs: Callable[[], Any]) -> None:
        self._kv = kv
        self._get_prefs = get_prefs
        self._lock = asyncio.Lock()

    # ----- configuration ------------------------------------------------- #
    def _config(self):
        prefs = self._get_prefs()
        return prefs.replay_capture

    # ----- capture ------------------------------------------------------- #
    async def sink(self, candidate: dict[str, Any]) -> None:
        """The pipeline capture hook. Bounded, deduped, and never truncating.

        Oversize bodies and overlong clusters are skipped WHOLE rather than trimmed:
        a truncated fixture would silently change the evidence a later replay is
        scored on, which is exactly the failure the harness exists to remove.
        """
        cfg = self._config()
        if not cfg.enabled or int(cfg.ring_size) <= 0:
            return
        mapping = candidate.get("field_mapping")
        if isinstance(mapping, dict) and mapping.get("status") == "conflict":
            # No single frozen connector can reproduce two disagreeing source
            # mappings, so the honest outcome is not to capture the fixture at all.
            await self._bump_skip("skipped_mapping_conflict")
            return
        members = list((candidate.get("cluster") or {}).get("member_events") or [])
        if len(members) > int(cfg.max_events_per_fixture):
            await self._bump_skip("skipped_too_many_events")
            return
        body = build_fixture(candidate)
        payload = payload_of(body) or {}
        # Measured on the ENCODED form, which is what actually occupies a slot.
        size = len(canonical_json(body).encode("utf-8"))
        if size > int(cfg.max_fixture_bytes):
            await self._bump_skip("skipped_oversize")
            return
        slot, orphans = await self._reserve_slot(
            body, payload, size, int(cfg.ring_size)
        )
        if slot is None:  # already captured (content dedup)
            return
        await self._kv.put(REPLAY_FIXTURES_NS, _slot_key(slot), body)
        # Scrub every slot this write evicted from the catalog. The slot the ring
        # reused was just overwritten anyway; a slot dropped because the operator
        # LOWERED ``ring_size`` would otherwise never be written or purged again,
        # silently breaking both the storage bound and the purge control.
        for stale in orphans:
            if stale == slot:
                continue
            try:
                await self._kv.put(REPLAY_FIXTURES_NS, _slot_key(stale), {})
            except Exception as exc:  # noqa: BLE001 — best-effort scrub
                logger.warning(
                    "replay fixture evicted-slot scrub failed for %s: %s", stale, exc
                )

    async def _reserve_slot(
        self,
        body: dict[str, Any],
        payload: dict[str, Any],
        size: int,
        ring_size: int,
    ) -> tuple[int | None, list[int]]:
        box: dict[str, Any] = {"slot": None, "orphans": []}

        def _mutate(current: dict[str, Any] | None) -> dict[str, Any]:
            # Pure over its snapshot: ``kv_mutate`` may re-run it on a CAS retry, so
            # nothing here writes — the scrub happens in ``sink`` once this returns.
            doc = _decode(current)
            digest = body["content_hash"]
            if any(entry["content_hash"] == digest for entry in doc["entries"]):
                box["slot"] = None
                box["orphans"] = []
                return _encode(doc)
            ring = max(1, ring_size)
            slot = int(doc["next_seq"]) % ring
            doc["next_seq"] = int(doc["next_seq"]) + 1
            before = {int(entry["slot"]) for entry in doc["entries"]}
            entries = [entry for entry in doc["entries"] if int(entry["slot"]) != slot]
            entries.append(_catalog_entry(body, payload, slot, size))
            doc["entries"] = entries[-ring:]
            after = {int(entry["slot"]) for entry in doc["entries"]}
            # The high-water slot space this catalog has ever addressed. Persisted so
            # ``clear`` stays exhaustive after the ring is shrunk.
            doc["ring_capacity"] = max(
                int(doc.get("ring_capacity", 0) or 0), ring, slot + 1
            )
            box["slot"] = slot
            box["orphans"] = sorted(before - after)
            return _encode(doc)

        await kv_mutate(
            self._kv, REPLAY_FIXTURES_NS, REPLAY_FIXTURES_KEY, _mutate, lock=self._lock
        )
        return box["slot"], list(box["orphans"])

    async def _bump_skip(self, counter: str) -> None:
        def _mutate(current: dict[str, Any] | None) -> dict[str, Any]:
            doc = _decode(current)
            doc[counter] = int(doc.get(counter, 0)) + 1
            return _encode(doc)

        await kv_mutate(
            self._kv, REPLAY_FIXTURES_NS, REPLAY_FIXTURES_KEY, _mutate, lock=self._lock
        )

    # ----- read ---------------------------------------------------------- #
    async def catalog(self) -> dict[str, Any]:
        try:
            raw = await self._kv.get(REPLAY_FIXTURES_NS, REPLAY_FIXTURES_KEY)
        except Exception as exc:  # noqa: BLE001 — the catalog is advisory to read
            logger.warning("replay fixture catalog read failed: %s", exc)
            raw = None
        return _decode(raw)

    async def load(self, fixture_id: str) -> LoadedFixture | None:
        """Return the verified fixture, or ``None`` when it is UNAVAILABLE.

        Unavailable means: not catalogued, its slot body is missing, it was captured
        under a different body schema, or the stored body no longer hashes to the
        catalogued ``content_hash`` (the slot has since been reused, or the body write
        that followed the catalog entry never landed). A caller must report that as
        not-measured, never as an empty result.
        """
        doc = await self.catalog()
        entry = next(
            (row for row in doc["entries"] if row["fixture_id"] == fixture_id), None
        )
        if entry is None:
            return None
        try:
            body = await self._kv.get(REPLAY_FIXTURES_NS, _slot_key(int(entry["slot"])))
        except Exception as exc:  # noqa: BLE001
            logger.warning("replay fixture slot read failed for %s: %s", fixture_id, exc)
            return None
        if not isinstance(body, dict) or not body.get("fixture_id"):
            return None
        if int(body.get("schema_version") or 0) != SCHEMA_VERSION:
            # Honest-unavailable rather than migrated: there is no backfill (#10), and a
            # foreign-schema body must not masquerade as slot-reuse corruption.
            logger.info(
                "replay fixture %s was captured under body schema v%s; reporting it "
                "unavailable",
                fixture_id, body.get("schema_version"),
            )
            return None
        payload = payload_of(body)
        if payload is None or content_hash_of(payload) != entry["content_hash"]:
            logger.warning(
                "replay fixture %s body no longer matches its catalogued hash; "
                "reporting it unavailable",
                fixture_id,
            )
            return None
        return LoadedFixture(body)

    async def stored_bytes(self) -> int:
        doc = await self.catalog()
        return sum(int(entry.get("bytes", 0) or 0) for entry in doc["entries"])

    # ----- purge --------------------------------------------------------- #
    async def clear(self) -> int:
        """Drop every catalogued fixture and overwrite every body slot ever addressed.

        Capture is on by default and fixtures hold raw records, so an operator needs a
        purge that does not require a factory reset. Bodies are overwritten rather
        than deleted because the KV contract has no delete primitive.

        The sweep is over the catalog's ``ring_capacity`` high-water mark, not over the
        slots the catalog still NAMES: lowering ``ring_size`` drops the higher entries
        from the catalog, and purging only what is still named would leave those raw
        records resident forever while reporting success.
        """
        doc = await self.catalog()
        removed = len(doc["entries"])
        named = {int(entry["slot"]) for entry in doc["entries"]}
        try:
            configured = int(self._config().ring_size)
        except Exception:  # noqa: BLE001 — the purge must not depend on prefs
            configured = 0
        high_water = max(
            [int(doc.get("ring_capacity", 0) or 0), configured, 0]
            + [slot + 1 for slot in named]
        )
        if not doc.get("ring_capacity") and named:
            # A catalog written before the high-water mark existed cannot say how far
            # its ring ever reached, so sweep the whole addressable slot space.
            high_water = max(high_water, RING_SIZE_MAX)

        def _mutate(current: dict[str, Any] | None) -> dict[str, Any]:
            kept = _decode(current)
            kept["entries"] = []
            return _encode(kept)

        await kv_mutate(
            self._kv, REPLAY_FIXTURES_NS, REPLAY_FIXTURES_KEY, _mutate, lock=self._lock
        )
        for slot in sorted(named | set(range(max(0, high_water)))):
            try:
                stored = await self._kv.get(REPLAY_FIXTURES_NS, _slot_key(slot))
            except Exception as exc:  # noqa: BLE001 — best-effort scrub
                logger.warning("replay fixture slot read failed for %s: %s", slot, exc)
                continue
            if not stored:
                continue
            try:
                await self._kv.put(REPLAY_FIXTURES_NS, _slot_key(slot), {})
            except Exception as exc:  # noqa: BLE001 — best-effort scrub
                logger.warning("replay fixture slot purge failed for %s: %s", slot, exc)
        return removed


def _slot_key(slot: int) -> str:
    return f"{REPLAY_FIXTURE_SLOT_PREFIX}{int(slot):04d}"


def _decode(raw: Any) -> dict[str, Any]:
    """Parse the catalog document, skipping corrupt rows and never raising."""
    doc: dict[str, Any] = {
        "next_seq": 0,
        "ring_capacity": 0,
        "entries": [],
        "skipped_oversize": 0,
        "skipped_too_many_events": 0,
        "skipped_mapping_conflict": 0,
    }
    if not isinstance(raw, dict):
        return doc
    doc["next_seq"] = max(0, _int(raw.get("next_seq")))
    doc["ring_capacity"] = max(0, _int(raw.get("ring_capacity")))
    doc["skipped_oversize"] = max(0, _int(raw.get("skipped_oversize")))
    doc["skipped_too_many_events"] = max(0, _int(raw.get("skipped_too_many_events")))
    doc["skipped_mapping_conflict"] = max(0, _int(raw.get("skipped_mapping_conflict")))
    entries: list[dict[str, Any]] = []
    for row in raw.get("entries") or []:
        if not isinstance(row, dict):
            continue
        fixture_id = str(row.get("fixture_id") or "")
        digest = str(row.get("content_hash") or "")
        if not fixture_id or not digest:
            continue
        entries.append(
            {
                "fixture_id": fixture_id,
                "content_hash": digest,
                "slot": _int(row.get("slot")),
                "captured_at_millis": _int(row.get("captured_at_millis")),
                "capture_app_version": str(row.get("capture_app_version") or ""),
                "capture_build_sha": str(row.get("capture_build_sha") or ""),
                "origin_case_id": str(row.get("origin_case_id") or ""),
                "source_surface": str(row.get("source_surface") or ""),
                "event_count": _int(row.get("event_count")),
                "bytes": _int(row.get("bytes")),
                "entity_type": str(row.get("entity_type") or ""),
                "rule_count": _int(row.get("rule_count")),
            }
        )
    doc["entries"] = entries
    return doc


def _encode(doc: dict[str, Any]) -> dict[str, Any]:
    return {
        "next_seq": int(doc.get("next_seq", 0)),
        "ring_capacity": int(doc.get("ring_capacity", 0)),
        "entries": list(doc.get("entries") or []),
        "skipped_oversize": int(doc.get("skipped_oversize", 0)),
        "skipped_too_many_events": int(doc.get("skipped_too_many_events", 0)),
        "skipped_mapping_conflict": int(doc.get("skipped_mapping_conflict", 0)),
    }


def _int(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0
