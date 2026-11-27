"""Cost gate helpers (Section 6.3).

Layered filtering keeps the expensive model away from most volume:
  1. query-time severity/scope filtering  -> ``es/querybuilder.scope_filters`` (free)
  2. dedup/suppression                     -> ``passes_suppression`` + open-case attach (free)
  3. cheap-router triage                   -> ``agents/router`` (cheap)
  4. per-case caps / kill switch           -> ``CaseBudget`` (safety)

This module owns layers 2 and 4.
"""

from __future__ import annotations

import time
from typing import Callable

from ..config import CapsConfig, Preferences
from ..models import Cluster
from ..utils import dotted_get

#: Share of the case time budget held back so the ONE post-loop formatter call can
#: still finish inside the deadline.
#:
#: A FRACTION of the case, deliberately not one whole per-request slice. The formatter
#: is a single short completion — one fixed message pair, no tools, no ReAct turn —
#: while ``request_timeout_seconds`` is sized for the LARGEST request a case makes.
#: Reserving one of those took EXACTLY HALF the case budget at the shipped defaults
#: (``min(60, 120/2) == 60``: the "clamp" bound exactly rather than protecting a corner
#: case), which stopped the ReAct loop at the midpoint of the operator's configured
#: timeout and turned investigations that used to reach a real verdict into
#: NEEDS_HUMAN with half the budget unspent.
#:
#: It is not tuned to any provider or deployment: a full investigation makes on the
#: order of ``max_tool_calls + 4`` model calls, so one call's fair share of the case is
#: already under a tenth of it at the shipped caps. 0.15 is that share with headroom for
#: a formatter prompt longer than an average ReAct turn, and it is still clamped below by
#: the configured per-request timeout so a small ``request_timeout_seconds`` wins.
FORMATTER_RESERVE_FRACTION = 0.15


def passes_suppression(cluster: Cluster, prefs: Preferences) -> bool:
    """False if EVERY member event matches a suppression rule (defence in depth;
    the query already excludes suppressed events at layer 1).

    Only LIVE rules count: a disabled or expired rule is skipped here AND at the
    query layer (``querybuilder.scope_must_not``), so toggling ``enabled`` off / an
    ``expires_at`` lapsing immediately stops suppressing without deleting the rule.
    Existing rules (no new fields) are always live (enabled True / no expiry)."""
    rules = [r for r in prefs.suppression_rules if r.is_live()]
    if not rules:
        return True
    for ev in cluster.member_events:
        suppressed = any(str(dotted_get(ev.source, r.field)) == r.value for r in rules)
        if not suppressed:
            return True
    return False


class CaseBudget:
    """Per-case caps and kill switch (Section 6.3 #4).

    A malformed alert cannot trigger runaway spend: tool calls and tokens are
    capped, and ``exceeded`` short-circuits the investigator loop.
    """

    def __init__(
        self, caps: CapsConfig, *, clock: Callable[[], float] = time.monotonic
    ) -> None:
        self._caps = caps
        self.tool_calls = 0
        self.tokens = 0
        self.capped_reason: str | None = None
        # --- TIME axis (opt-in; see ``start()``). Unstamped == every time accessor
        # returns None and this budget behaves EXACTLY as it did before. A monotonic
        # clock (never the wall clock) so an NTP step cannot move a live deadline; it
        # is injectable purely so the tests can drive it deterministically.
        self._clock = clock
        self._deadline: float | None = None
        self._request_timeout: float | None = None
        self._reserve: float = 0.0
        self._span: float = 0.0
        # The longest model request this case has actually COMPLETED — the only
        # deployment-agnostic evidence available about how long the next one needs.
        self._longest_request: float = 0.0

    @property
    def kill_switch(self) -> bool:
        return self._caps.kill_switch

    def can_call_tool(self) -> bool:
        if self._caps.kill_switch:
            self.capped_reason = "kill switch engaged"
            return False
        if self.tool_calls >= self._caps.max_tool_calls:
            self.capped_reason = f"max_tool_calls ({self._caps.max_tool_calls}) reached"
            return False
        return True

    def record_tool_call(self) -> None:
        self.tool_calls += 1

    def add_tokens(self, prompt_tokens: int, completion_tokens: int) -> None:
        self.tokens += prompt_tokens + completion_tokens

    def exceeded(self) -> bool:
        if self._caps.kill_switch:
            self.capped_reason = "kill switch engaged"
            return True
        if self.tokens >= self._caps.max_tokens:
            self.capped_reason = f"max_tokens ({self._caps.max_tokens}) reached"
            return True
        return False

    # ------------------------------------------------------------------ #
    # Time axis — the per-request bound, bounded by the remaining case budget.
    # ------------------------------------------------------------------ #
    def start(
        self,
        *,
        timeout_seconds: float | None = None,
        request_timeout_seconds: float | None = None,
    ) -> None:
        """Stamp the case wall-clock deadline. NO-OP until called (#5: an absent config
        leaves every accessor at ``None`` and the budget behaves exactly as before).

        ⚠ STAMP AT THE ``asyncio.wait_for`` SITE, NOT AT CONSTRUCTION. The budget is
        constructed BEFORE enrichment, persona/playbook selection and the platform-tuning
        snapshot; a deadline stamped there would already be partly spent by the time the
        outer ``wait_for`` clock actually starts, so the two clocks would disagree and this
        budget would report time the investigation genuinely still has.

        WHY A PER-REQUEST BOUND AT ALL: one logical completion can occupy
        ``attempts × per-request-timeout + backoff``, and a case makes several of them. A
        case cap SMALLER than one retry ladder therefore guillotines the FIRST degraded
        call before any retry can land — the outer ``wait_for`` cancels the whole
        investigation coroutine, so the reasoning accumulated so far is discarded and the
        spend has to be reconstructed from a side-channel. Bounding each request by
        ``min(configured per-request timeout, time actually left)`` lets the loop stop
        COOPERATIVELY instead.

        ``_reserve`` keeps a small slice of the case budget in hand so the post-loop
        formatter call (exactly one more model call) can still complete inside the
        deadline rather than being cut off by the outer ``wait_for``. It is
        :data:`FORMATTER_RESERVE_FRACTION` of the case, further clamped by the configured
        per-request timeout — so it never exceeds what one request may take, and on a
        deliberately tiny ``timeout_seconds`` it stays proportionally tiny instead of
        swallowing the budget before a single model call is attempted."""
        span = float(timeout_seconds or 0.0)
        req = float(request_timeout_seconds or 0.0)
        self._request_timeout = req if req > 0 else None
        self._span = max(0.0, span)
        if span <= 0:
            self._deadline = None
            self._reserve = 0.0
            return
        self._deadline = self._clock() + span
        self._reserve = (
            min(req, span * FORMATTER_RESERVE_FRACTION) if req > 0 else 0.0
        )

    def remaining(self) -> float | None:
        """Seconds left before the stamped case deadline (never negative), or ``None``
        when no deadline was stamped."""
        if self._deadline is None:
            return None
        return max(0.0, self._deadline - self._clock())

    def note_request(self, started_at: float) -> None:
        """Record how long one COMPLETED model request took.

        Measured on the budget's OWN clock (pair it with :meth:`request_started`) so an
        injected clock is honoured and no second time source can disagree with the
        deadline. Only completed calls are noted: a request that was cut off says
        nothing about how long a healthy one needs."""
        try:
            elapsed = float(self._clock()) - float(started_at)
        except (TypeError, ValueError):  # pragma: no cover - defensive
            return
        if elapsed > self._longest_request:
            self._longest_request = elapsed

    def request_started(self) -> float:
        """The budget's own clock reading, to hand back to :meth:`note_request`."""
        return self._clock()

    def _min_viable_slice(self) -> float:
        """The smallest slice worth DISPATCHING a request under.

        Zero until this case has completed a model call: with no evidence about how long
        a request takes on this deployment, declining to start one would be a guess.
        After that it is the LONGEST completed call — the only deployment-agnostic
        statement available, and deliberately the conservative one, because a request
        that is issued and then abandoned still costs real provider spend (the gateway
        ledgers it as ``abandoned``) and contributes nothing to the investigation in
        return."""
        return max(0.0, self._longest_request)

    def time_exhausted(self) -> bool:
        """True once the case can no longer usefully start another model call.

        Two ways to get there, both reported through ``capped_reason`` exactly like the
        token/tool caps, so the loop's existing ``[capped] …`` reasoning line explains
        the stop:

        * the remaining budget is down to the formatter reserve, or
        * what is left OUTSIDE the reserve is shorter than the longest request this case
          has already completed — i.e. the loop would be issuing a call it has already
          worked out it cannot wait for.

        Always False when no deadline was stamped."""
        rem = self.remaining()
        if rem is None:
            return False
        usable = rem - self._reserve
        if usable <= 0:
            self.capped_reason = (
                f"case time budget exhausted ({round(rem, 3)}s left of the "
                f"{round(self._span, 3)}s timeout_seconds cap, and "
                f"{round(self._reserve, 3)}s of it is held back to finish the case on "
                f"the normal path)"
            )
            return True
        viable = self._min_viable_slice()
        if usable < viable:
            self.capped_reason = (
                f"case time budget exhausted ({round(usable, 3)}s of usable budget is "
                f"less than the {round(viable, 3)}s the longest model request in this "
                f"case took, so another request would be abandoned rather than answered)"
            )
            return True
        return False

    def request_timeout(self) -> float | None:
        """The bound for ONE model request: the configured per-request timeout, further
        bounded by the case time ACTUALLY left (minus the formatter reserve).

        ``None`` when neither a per-request timeout nor a deadline is configured — the
        caller then applies no bound of its own, which is the pre-change behaviour.

        This is a CEILING, not a promise that the slice is usable: ``time_exhausted()``
        is what stops the loop before the slice shrinks below a request that could
        actually finish."""
        rem = self.remaining()
        cfg = self._request_timeout
        if rem is None:
            return cfg
        usable = max(0.0, rem - self._reserve)
        return usable if cfg is None else min(cfg, usable)
