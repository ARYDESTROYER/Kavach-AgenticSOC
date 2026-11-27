"""Process-local admission fence for tenant-state HTTP mutations.

Factory reset is a privacy boundary, not an ordinary best-effort write.  Closing
this gate rejects new unsafe HTTP requests and lets the reset worker wait until
every already-admitted request has left its response boundary before any tenant
state is cleared.  The durable Jobs/Batch CAS fences remain the cross-worker
authority; this gate closes the remaining single-process HTTP race.
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from collections.abc import AsyncIterator


class MutationAdmissionClosed(RuntimeError):
    """Raised when an unsafe request reaches a closed factory-reset boundary."""


class MutationAdmissionGate:
    """Count admitted unsafe requests and provide one exclusive factory owner.

    The gate is deliberately process-local.  A supported single backend process
    receives an exact drain guarantee; durable Jobs/Batch CAS fences prevent a
    second application worker from claiming/submitting work, but arbitrary HTTP
    writers in a multi-replica topology require an external admission layer.
    """

    def __init__(self) -> None:
        self._condition = asyncio.Condition()
        self._owner = ""
        self._active = 0
        self._degraded = False

    @property
    def closed(self) -> bool:
        return bool(self._owner)

    @property
    def degraded(self) -> bool:
        return bool(self._owner and self._degraded)

    @property
    def owner(self) -> str:
        return self._owner

    @property
    def active(self) -> int:
        return self._active

    @asynccontextmanager
    async def admit(self) -> AsyncIterator[None]:
        """Admit one unsafe HTTP request or fail before its handler runs."""

        async with self._condition:
            if self._owner:
                raise MutationAdmissionClosed(
                    "factory reset is in progress; tenant mutations are temporarily disabled"
                )
            self._active += 1
        try:
            yield
        finally:
            async with self._condition:
                self._active = max(0, self._active - 1)
                self._condition.notify_all()

    async def close(self, owner: str) -> None:
        """Close admission for ``owner``; a degraded retry may transfer ownership."""

        owner = str(owner or "").strip()
        if not owner:
            raise ValueError("mutation-gate owner is required")
        async with self._condition:
            if self._owner and self._owner != owner:
                if not self._degraded:
                    raise RuntimeError("another factory reset owns mutation admission")
                # JobStore has already performed the strict fresh-authority transfer.
                # Keep admission continuously closed while the recovery worker takes over.
                self._owner = owner
                self._degraded = False
            elif not self._owner:
                self._owner = owner
                self._degraded = False
            self._condition.notify_all()

    async def wait_drained(self, owner: str, *, timeout: float) -> None:
        """Wait until every request admitted before :meth:`close` has completed."""

        async def _wait() -> None:
            async with self._condition:
                if self._owner != owner:
                    raise RuntimeError("mutation-gate ownership changed")
                while self._active:
                    await self._condition.wait()
                    if self._owner != owner:
                        raise RuntimeError("mutation-gate ownership changed")

        await asyncio.wait_for(_wait(), timeout=max(0.1, float(timeout)))

    async def mark_degraded(self, owner: str) -> None:
        """Keep admission closed while allowing only explicit recovery endpoints."""

        async with self._condition:
            if self._owner != owner:
                raise RuntimeError("mutation-gate ownership changed")
            self._degraded = True
            self._condition.notify_all()

    async def open(self, owner: str) -> None:
        """Release a confirmed factory boundary; ordinary mutation may resume."""

        async with self._condition:
            if self._owner != owner:
                raise RuntimeError("mutation-gate ownership changed")
            if self._active:
                raise RuntimeError("cannot open mutation admission while requests are active")
            self._owner = ""
            self._degraded = False
            self._condition.notify_all()
