"""BudgetGate — a PURE LLM-cost pre-flight check (Round 3, Feature 9, Track B).

The suite already meters every model call through the ONE gateway ledger (#6). This
gate reads the rolling spend back OUT of that ledger and compares it to the
operator-configured daily / monthly ceilings (``Preferences.budget``) BEFORE a
billable call is made. It returns a decision dict:

* ``{"action": "allow"}``                      — under all ceilings (or budget off).
* ``{"action": "warn", "reason": ...}``        — past ``soft_warn_pct`` of a ceiling,
                                                  or over a ceiling when ``on_exceed`` is
                                                  ``"warn"`` (the call still proceeds).
* ``{"action": "block", "reason": ...}``       — over a ceiling AND ``on_exceed`` is
                                                  ``"block"``.

⚠ NON-NEGOTIABLE #3: a ``block`` decision only governs whether an investigation
*runs*. The gateway turns a block into a ``GatewayError`` so the caller fails the
alert to NEEDS_HUMAN — it NEVER closes a case and NEVER touches
``case_manager.decide()``. The advisory spend numbers are READ-only governance; they
are not an input to any verdict/close decision.

The gate is PURE in the sense that it has no side effects: it only READS
``usage.summary()`` and the config, and returns a decision. It NEVER raises into the
caller on a read failure — it degrades to ``allow`` (fail-open governance: a ledger
glitch must not stop the SOC from triaging). Demo / mock / $0 calls are filtered out
by the gateway before this gate is even consulted.
"""

from __future__ import annotations

import logging
import math
from typing import Any, Sequence

from ..llm.pricing import resolve_price
from ..utils import now_utc

logger = logging.getLogger("tlsoc.engine.budget")

# Rolling windows (hours) for the two ceilings. "Daily" mirrors the ledger's
# today-bucket cadence; "monthly" is a 30-day rolling window.
_DAILY_HOURS = 24
_MONTHLY_HOURS = 24 * 30

# An OpenAI-ish heuristic for turning a prompt's character count into an input-token
# estimate (~4 chars/token), matching providers._estimate_tokens so the pre-flight
# estimate is consistent with what the ledger will later record.
_CHARS_PER_TOKEN = 4


def estimate_tokens_from_chars(prompt_chars: int) -> int:
    return max(1, int(prompt_chars) // _CHARS_PER_TOKEN)


#: Round 12 (SPEC D5): surfaces whose spend the daily AI budget does not count (the
#: gateway also never blocks them). Chat has its own optional daily cap instead. Kept
#: equal to ``llm.gateway.BUDGET_EXEMPT_SURFACES`` (pinned by a test).
EXCLUDED_SURFACES: tuple[str, ...] = ("chat",)


def _surface_cost(summary: dict[str, Any] | None, surfaces: Sequence[str]) -> float:
    """The cost of ``surfaces`` in a usage ``summary``'s ``by_surface`` rows."""
    if not isinstance(summary, dict) or not surfaces:
        return 0.0
    total = 0.0
    for row in summary.get("by_surface") or []:
        if isinstance(row, dict) and row.get("key") in surfaces:
            try:
                total += float(row.get("cost") or 0.0)
            except (TypeError, ValueError):
                continue
    return total


def _today_surface_cost(summary: dict[str, Any] | None, surfaces: Sequence[str]) -> float | None:
    """The spend on ``surfaces`` since 00:00 UTC (the ledger's today bucket, the same
    rows as ``today_cost``) from a usage ``summary``'s exact ``today_by_surface`` rows;
    ``None`` when the repository does not report them (an out-of-tree store)."""
    if not isinstance(summary, dict) or not isinstance(summary.get("today_by_surface"), list):
        return None
    return _surface_cost({"by_surface": summary["today_by_surface"]}, surfaces)


def _hours_since_midnight(*, ceil: bool) -> int:
    """Whole hours since 00:00 UTC (the ledger's today bucket), rounded down or up.
    Only the fallback for a usage repository without ``today_by_surface``."""
    now = now_utc()
    elapsed = (now - now.replace(hour=0, minute=0, second=0, microsecond=0)).total_seconds() / 3600
    return int(math.ceil(elapsed)) if ceil else int(elapsed)


class BudgetGate:
    """Pure pre-flight budget ceiling check. Construct with a ``get_budget`` callable
    returning the live :class:`app.config.BudgetConfig` (so a settings change is
    honoured without a rewire) and the shared ``UsageStore`` (read-only here).

    All methods are read-only + best-effort: a usage-read failure degrades to
    ``allow`` so the gate can never lock the SOC out of triaging on a ledger glitch.
    """

    def __init__(self, get_budget, usage_store) -> None:
        self._get_budget = get_budget
        self._usage = usage_store

    # ----- cost estimation -----
    def estimate_cost(self, prompt: str | int, max_tokens: int,
                      model: str = "", overlay: tuple[float, float] | None = None) -> float:
        """A USD estimate for a single call: the prompt priced as input tokens +
        ``max_tokens`` priced as output tokens. Worst-case in the OUTPUT dimension
        only (the model may emit fewer); the INPUT term APPROXIMATES tokenisation at
        four characters per token, so a denser real tokenisation can record more than
        this estimated. ``prompt`` may be the text or an already-counted char length.
        Uses the same price resolution the ledger uses (overlay → table → registry →
        heuristic → default), so the pre-flight estimate matches the recorded cost."""
        prompt_chars = prompt if isinstance(prompt, int) else len(str(prompt))
        in_tokens = estimate_tokens_from_chars(prompt_chars)
        out_tokens = max(0, int(max_tokens))
        in_rate, out_rate = resolve_price(model or "", overlay)
        return round(
            (in_tokens / 1_000_000.0) * in_rate + (out_tokens / 1_000_000.0) * out_rate, 8
        )

    # ----- the gate -----
    async def check(self, *, prompt_chars: int = 0, max_tokens: int = 0, model: str = "",
                    overlay: tuple[float, float] | None = None,
                    exclude_surfaces: Sequence[str] = ()) -> dict[str, Any]:
        """Decide whether a call costing ~``estimate_cost`` may proceed. Returns an
        ``{"action": allow|warn|block, ...}`` decision (never raises). Budget OFF →
        always ``allow``. The estimated cost of the IMMINENT call is added to the
        already-spent window total before comparing to a ceiling, so the gate blocks
        the call that WOULD cross the line, not only the one after.

        ``exclude_surfaces`` (Round 12, D5; the gateway passes the chat surface): spend
        on those surfaces does not count toward the ceilings."""
        budget = self._budget()
        if budget is None or not getattr(budget, "enabled", False):
            return {"action": "allow"}
        estimate = self.estimate_cost(prompt_chars, max_tokens, model, overlay)
        spent = await self._window_spend(exclude_surfaces)
        return self._decide(budget, spent, estimate)

    async def surface_spend_today(self, surface: str) -> float:
        """Today's spend (since 00:00 UTC, the ledger's today bucket) on one ledger
        ``surface`` (Round 12: the chat daily cap), exact from the summary's
        ``today_by_surface``. A repository without it is read over the whole hours
        since midnight rounded UP (never under-counts: the safe side of a cap).
        Degrades to $0 on a read failure (fail-open, like every budget read)."""
        try:
            summary = await self._usage.summary(window_hours=_DAILY_HOURS)
            exact = _today_surface_cost(summary, (surface,))
            if exact is not None:
                return exact
            summary = await self._usage.summary(window_hours=max(1, _hours_since_midnight(ceil=True)))
        except Exception as exc:  # noqa: BLE001
            logger.warning("surface spend read failed (%s); assuming $0", exc)
            return 0.0
        return _surface_cost(summary, (surface,))

    async def status(self, exclude_surfaces: Sequence[str] = EXCLUDED_SURFACES) -> dict[str, Any]:
        """A read-only governance snapshot for ``GET /api/budget/status``: the live
        config, the rolling daily/monthly spend, the ceilings, the fraction used, and
        the current band (ok|warn|over) per window. Never raises.

        Round 12 (D5): the figures are what the gate enforces, so chat spend (outside
        the budget) is excluded by default and reported apart as ``excluded_today``."""
        budget = self._budget()
        spent = await self._window_spend(exclude_surfaces)
        enabled = bool(getattr(budget, "enabled", False)) if budget else False
        daily_cap = _f(getattr(budget, "daily_usd", None)) if budget else None
        monthly_cap = _f(getattr(budget, "monthly_usd", None)) if budget else None
        warn_pct = float(getattr(budget, "soft_warn_pct", 0.8) or 0.8) if budget else 0.8
        on_exceed = str(getattr(budget, "on_exceed", "warn") or "warn") if budget else "warn"
        return {
            "enabled": enabled,
            "on_exceed": on_exceed,
            "soft_warn_pct": warn_pct,
            "currency": "USD",
            "daily": _window_status(spent["daily"], daily_cap, warn_pct),
            "monthly": _window_status(spent["monthly"], monthly_cap, warn_pct),
            "excluded_surfaces": list(exclude_surfaces),
            "excluded_today": round(spent.get("excluded_daily", 0.0), 6),
        }

    # ----- internals -----
    def _budget(self):
        try:
            return self._get_budget()
        except Exception as exc:  # noqa: BLE001
            logger.warning("budget config read failed (%s); treating as OFF", exc)
            return None

    async def _window_spend(self, exclude_surfaces: Sequence[str] = ()) -> dict[str, float]:
        """Rolling daily + monthly spend (USD) from the usage ledger. The daily figure
        is the ledger's ``today_cost`` (calendar-day bucket), the monthly is the
        30-day rolling ``total_cost``. Degrades to zeros on a read failure (fail-open).

        ``exclude_surfaces`` (Round 12, D5) subtracts those surfaces' spend exactly:
        for the monthly window from the same rows' ``by_surface``, and for the day from
        the same read's ``today_by_surface`` (the rows since 00:00 UTC that make up
        ``today_cost``). Only a repository that does not report ``today_by_surface``
        falls back to the whole hours since midnight rounded DOWN, so the excluded
        share is never over-estimated and the pipeline backstop never under-counts
        (#10)."""
        daily = 0.0
        monthly = 0.0
        excluded_daily = 0.0
        day: dict[str, Any] | None = None
        try:
            day = await self._usage.summary(window_hours=_DAILY_HOURS)
            daily = float(day.get("today_cost", day.get("total_cost", 0.0)) or 0.0)
        except Exception as exc:  # noqa: BLE001
            logger.warning("daily spend read failed (%s); assuming $0", exc)
        try:
            month = await self._usage.summary(window_hours=_MONTHLY_HOURS)
            monthly = float(month.get("total_cost", 0.0) or 0.0)
            if exclude_surfaces:
                monthly = max(0.0, monthly - _surface_cost(month, exclude_surfaces))
        except Exception as exc:  # noqa: BLE001
            logger.warning("monthly spend read failed (%s); assuming $0", exc)
        if exclude_surfaces and daily > 0:
            exact = _today_surface_cost(day, exclude_surfaces)
            if exact is not None:
                excluded_daily = min(daily, exact)
            else:
                hours = _hours_since_midnight(ceil=False)
                try:
                    today = await self._usage.summary(window_hours=hours) if hours > 0 else None
                    excluded_daily = min(daily, _surface_cost(today, exclude_surfaces))
                except Exception as exc:  # noqa: BLE001
                    logger.warning("excluded spend read failed (%s); counting it", exc)
            daily = max(0.0, daily - excluded_daily)
        return {"daily": daily, "monthly": monthly, "excluded_daily": excluded_daily}

    def _decide(self, budget, spent: dict[str, float], estimate: float) -> dict[str, Any]:
        on_exceed = str(getattr(budget, "on_exceed", "warn") or "warn")
        warn_pct = float(getattr(budget, "soft_warn_pct", 0.8) or 0.8)
        caps = {
            "daily": _f(getattr(budget, "daily_usd", None)),
            "monthly": _f(getattr(budget, "monthly_usd", None)),
        }
        warnings: list[str] = []
        for window, cap in caps.items():
            if cap is None or cap <= 0:
                continue  # an unset / non-positive ceiling is "no limit"
            projected = spent.get(window, 0.0) + estimate
            if projected > cap:
                reason = (
                    f"{window} spend ${spent.get(window, 0.0):.4f} + est ${estimate:.4f} "
                    f"would exceed the ${cap:.2f} {window} ceiling"
                )
                if on_exceed == "block":
                    return {"action": "block", "reason": reason, "window": window,
                            "spent": round(spent.get(window, 0.0), 6), "cap": cap,
                            "estimate": estimate}
                warnings.append(reason)
            elif projected >= cap * warn_pct:
                warnings.append(
                    f"{window} spend at {projected / cap:.0%} of the ${cap:.2f} ceiling"
                )
        if warnings:
            return {"action": "warn", "reason": "; ".join(warnings)}
        return {"action": "allow"}


def _f(value: Any) -> float | None:
    try:
        if value is None:
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def _window_status(spent: float, cap: float | None, warn_pct: float) -> dict[str, Any]:
    if cap is None or cap <= 0:
        return {"spent": round(spent, 6), "cap": None, "fraction": None, "band": "ok"}
    fraction = spent / cap if cap else 0.0
    band = "over" if spent > cap else ("warn" if fraction >= warn_pct else "ok")
    return {"spent": round(spent, 6), "cap": cap, "fraction": round(fraction, 4), "band": band}
