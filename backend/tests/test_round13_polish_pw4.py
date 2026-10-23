"""Round 13 polish, third re-shoot (PW4-10): the funnel's baseline flush is ONE write.

Measured on the Demo (production web build, 1440 px, six cold Case Manager chats): the
first case chip took 4.2 s and 8.0 s in two runs while the starters read itself took
about 20 ms. py-spy put 94 % of the backend's samples in the Demo ticker's
``_flush_funnel_baseline``: one ``BaselineStore.put`` per observed signature, each
decoding and re-encoding the WHOLE series document, with no ``await`` that yields on an
in-memory KV, so every API call waited 4 to 8 s every 15 to 20 s.

``BaselineStore.put_many`` writes every touched signature in one read-modify-write that
encodes only those signatures and keeps the others as stored; both flushes (the Demo
ticker and the realtime EVENT funnel in ``AppState``) use it.
"""

from __future__ import annotations

import pytest

from app.models import BaselineState
from app.state import AppState
from app.stores.baseline import BaselineStore


class _CountingKV:
    """Wraps a KV and counts writes to the baseline document."""

    def __init__(self, inner) -> None:
        self._inner = inner
        self.writes = 0

    async def get(self, ns, key):
        return await self._inner.get(ns, key)

    async def put(self, ns, key, value):
        self.writes += 1
        return await self._inner.put(ns, key, value)


@pytest.mark.asyncio
async def test_put_many_writes_every_signature_once_and_keeps_the_rest(app_state: AppState) -> None:
    store = BaselineStore(app_state._kv)
    await store.put("kept", {3: BaselineState(n_samples=4, welford_m=2.0)})
    await store.put("replaced", {0: BaselineState(n_samples=1)})

    counting = _CountingKV(app_state._kv)
    batch = BaselineStore(counting)
    await batch.put_many(
        {
            "replaced": {7: BaselineState(n_samples=9), 2: BaselineState(n_samples=2)},
            "new": {160: BaselineState(n_samples=5, warm=True)},
        }
    )
    # One write for the whole batch (a write per signature re-encoded the document each time).
    assert counting.writes == 1

    series = await store.snapshot()
    assert sorted(series) == ["kept", "new", "replaced"]
    # The untouched series is exactly as stored; a replaced one is replaced, not merged.
    assert series["kept"][3].model_dump() == BaselineState(n_samples=4, welford_m=2.0).model_dump()
    assert sorted(series["replaced"]) == [2, 7]
    assert series["replaced"][7].n_samples == 9
    assert series["new"][160].warm is True

    # The document stays in the stable order `put` writes: signatures and buckets sorted.
    doc = await app_state._kv.get("baseline", "baseline")
    assert list(doc["series"]) == ["kept", "new", "replaced"]
    assert list(doc["series"]["replaced"]) == ["2", "7"]


@pytest.mark.asyncio
async def test_put_many_with_nothing_to_write_does_not_touch_the_store(app_state: AppState) -> None:
    counting = _CountingKV(app_state._kv)
    await BaselineStore(counting).put_many({})
    assert counting.writes == 0


@pytest.mark.asyncio
async def test_put_many_drops_a_malformed_series_shape_and_never_raises(app_state: AppState) -> None:
    # A series that is not a mapping is dropped from the document; a write never raises.
    await app_state._kv.put("baseline", "baseline", {"series": {"bad": [1, 2], "ok": {"0": {"n_samples": 1}}}})
    store = BaselineStore(app_state._kv)
    await store.put_many({"fresh": {1: BaselineState(n_samples=3)}})
    doc = await app_state._kv.get("baseline", "baseline")
    assert sorted(doc["series"]) == ["fresh", "ok"]
    assert (await store.get("ok"))[0].n_samples == 1


@pytest.mark.asyncio
async def test_the_realtime_funnel_flush_is_one_store_write(app_state: AppState, monkeypatch) -> None:
    calls: list[list[str]] = []

    async def _put_many(updates):
        calls.append(sorted(updates))

    async def _put(*_args, **_kwargs):  # pragma: no cover - the flush must not use it
        raise AssertionError("the funnel flush wrote one signature at a time")

    monkeypatch.setattr(app_state.baseline_store, "put_many", _put_many)
    monkeypatch.setattr(app_state.baseline_store, "put", _put)

    class _Engine:
        def snapshot(self, sig):
            return {0: BaselineState(n_samples=1)} if sig != "empty" else {}

    class _Cand:
        def __init__(self, sig):
            self.signature = sig

    await app_state._flush_funnel_baseline(_Engine(), [_Cand("a"), _Cand("b"), _Cand("empty")], [], app_state.prefs)
    assert calls == [["a", "b"]]
