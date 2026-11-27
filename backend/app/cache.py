"""Small async cache with a Redis backend and an in-memory fallback.

Enrichment is Redis-cached (Section 6.5 / Non-negotiable #8) to protect both cost
and tight free-tier API limits. If Redis is unreachable the cache degrades to a
process-local dict so the suite still runs — it simply loses cross-restart and
cross-replica sharing.
"""

from __future__ import annotations

import json
import logging
import time
from collections import OrderedDict
from typing import Any

logger = logging.getLogger("tlsoc.cache")

# Hard LRU cap on the in-memory fallback (audit #37): with Redis down the fallback dict
# would otherwise grow without bound (one entry per enrichment key, ~forever). Past this,
# the least-recently-used entry is evicted.
_MEM_MAX_ENTRIES = 10_000


class Cache:
    def __init__(self, redis_url: str | None = None) -> None:
        self._url = redis_url
        self._redis: Any = None
        # LRU-ordered: key -> (expiry_epoch, value). Bounded by _MEM_MAX_ENTRIES.
        self._mem: OrderedDict[str, tuple[float, str]] = OrderedDict()
        self._warned = False
        # Persisted factory-reset receipt ids become cache namespaces. This makes all
        # old enrichment/notification keys unreachable after a tenant reset without a
        # Redis-wide scan/delete and survives process restarts.
        self._tenant_epoch = "legacy"

    def set_tenant_epoch(self, epoch: str) -> None:
        normalized = str(epoch or "legacy").strip() or "legacy"
        if normalized == self._tenant_epoch:
            return
        self._tenant_epoch = normalized
        self._mem.clear()
        self._warned = False

    def _qualified(self, key: str) -> str:
        return f"agentic-soc:tenant:{self._tenant_epoch}:{key}"

    async def connect(self) -> None:
        if not self._url:
            return
        try:
            import redis.asyncio as aioredis  # local import keeps redis optional

            client = aioredis.from_url(self._url, encoding="utf-8", decode_responses=True)
            await client.ping()
            self._redis = client
            logger.info("Cache connected to Redis at %s", self._url)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Redis unavailable (%s); using in-memory cache fallback", exc)
            self._redis = None

    async def get(self, key: str) -> str | None:
        key = self._qualified(key)
        if self._redis is not None:
            try:
                return await self._redis.get(key)
            except Exception as exc:  # noqa: BLE001
                self._fallback_warn(exc)
        return self._mem_get(key)

    async def set(self, key: str, value: str, ttl_seconds: int) -> None:
        key = self._qualified(key)
        if self._redis is not None:
            try:
                await self._redis.set(key, value, ex=ttl_seconds)
                return
            except Exception as exc:  # noqa: BLE001
                self._fallback_warn(exc)
        now = time.time()
        self._mem[key] = (now + ttl_seconds, value)
        self._mem.move_to_end(key)  # most-recently-used
        # Opportunistic bounded expiry sweep (cheap, front of the LRU where the oldest,
        # most-likely-expired entries live), then the hard LRU cap.
        for k in [k for k, (exp, _) in list(self._mem.items())[:32] if exp < now]:
            self._mem.pop(k, None)
        while len(self._mem) > _MEM_MAX_ENTRIES:
            self._mem.popitem(last=False)  # evict least-recently-used

    async def get_json(self, key: str) -> Any | None:
        raw = await self.get(key)
        if raw is None:
            return None
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return None

    async def set_json(self, key: str, value: Any, ttl_seconds: int) -> None:
        await self.set(key, json.dumps(value), ttl_seconds)

    def _mem_get(self, key: str) -> str | None:
        item = self._mem.get(key)
        if not item:
            return None
        expiry, value = item
        if expiry < time.time():
            self._mem.pop(key, None)
            return None
        self._mem.move_to_end(key)  # LRU: a hit refreshes recency
        return value

    def _fallback_warn(self, exc: Exception) -> None:
        if not self._warned:
            logger.warning("Redis error (%s); falling back to in-memory cache", exc)
            self._warned = True

    async def aclose(self) -> None:
        if self._redis is not None:
            try:
                await self._redis.aclose()
            except Exception:  # noqa: BLE001
                pass
