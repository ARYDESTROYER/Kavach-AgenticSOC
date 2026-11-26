"""One process-wide, priority-aware investigation concurrency gate."""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from typing import AsyncIterator, Literal

InvestigationPriority = Literal["ingest", "background"]


class InvestigationGate:
    """Bound all pipeline callers together while preserving ingest headroom.

    Background jobs use at most ``cap - 1`` slots when cap is greater than one.
    At cap one, they may use the only slot, but any queued ingest caller is admitted
    before the next background caller. This is process-local by design; provider and
    budget rails still apply independently in every replica.
    """

    def __init__(self) -> None:
        self._condition = asyncio.Condition()
        self._active = 0
        self._background_active = 0
        self._ingest_waiters = 0

    @property
    def active(self) -> int:
        return self._active

    def would_wait(self, cap: int, priority: InvestigationPriority = "ingest") -> bool:
        """Whether a caller asking now for a permit at ``priority`` would wait (Round
        16, WP16): the same test :meth:`permit` waits on, read without changing
        anything. A background caller also waits while an ingest caller is queued or
        while the background slots (``cap - 1`` when ``cap`` is above one) are full, so
        a run can say it is queued even when a slot looks free."""
        limit = max(1, int(cap or 1))
        if self._active >= limit:
            return True
        if priority != "background":
            return False
        return self._ingest_waiters > 0 or self._background_active >= max(1, limit - 1)

    @asynccontextmanager
    async def permit(
        self,
        cap: int,
        priority: InvestigationPriority = "ingest",
    ) -> AsyncIterator[None]:
        limit = max(1, int(cap or 1))
        background_limit = max(1, limit - 1)
        ingest = priority != "background"
        async with self._condition:
            if ingest:
                self._ingest_waiters += 1
            try:
                await self._condition.wait_for(
                    lambda: self._active < limit
                    and (
                        ingest
                        or (
                            self._ingest_waiters == 0
                            and self._background_active < background_limit
                        )
                    )
                )
                self._active += 1
                if not ingest:
                    self._background_active += 1
            finally:
                if ingest:
                    self._ingest_waiters -= 1
                    # A cancelled ingest waiter may have been the only reason a
                    # background waiter was ineligible. Wake it immediately; no
                    # permit release is otherwise guaranteed to follow.
                    self._condition.notify_all()
        try:
            yield
        finally:
            async with self._condition:
                self._active -= 1
                if not ingest:
                    self._background_active -= 1
                self._condition.notify_all()
