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
from typing import Any

from ..llm.pricing import resolve_price

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
                    overlay: tuple[float, float] | None = None) -> dict[str, Any]:
        """Decide whether a call costing ~``estimate_cost`` may proceed. Returns an
        ``{"action": allow|warn|block, ...}`` decision (never raises). Budget OFF →
        always ``allow``. The estimated cost of the IMMINENT call is added to the
        already-spent window total before comparing to a ceiling, so the gate blocks
        the call that WOULD cross the line, not only the one after."""
        budget = self._budget()
        if budget is None or not getattr(budget, "enabled", False):
            return {"action": "allow"}
        estimate = self.estimate_cost(prompt_chars, max_tokens, model, overlay)
        spent = await self._window_spend()
        return self._decide(budget, spent, estimate)

    async def status(self) -> dict[str, Any]:
        """A read-only governance snapshot for ``GET /api/budget/status``: the live
        config, the rolling daily/monthly spend, the ceilings, the fraction used, and
        the current band (ok|warn|over) per window. Never raises."""
        budget = self._budget()
        spent = await self._window_spend()
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
        }

    # ----- internals -----
    def _budget(self):
        try:
            return self._get_budget()
        except Exception as exc:  # noqa: BLE001
            logger.warning("budget config read failed (%s); treating as OFF", exc)
            return None

    async def _window_spend(self) -> dict[str, float]:
        """Rolling daily + monthly spend (USD) from the usage ledger. The daily figure
        is the ledger's ``today_cost`` (calendar-day bucket), the monthly is the
        30-day rolling ``total_cost``. Degrades to zeros on a read failure (fail-open)."""
        daily = 0.0
        monthly = 0.0
        try:
            day = await self._usage.summary(window_hours=_DAILY_HOURS)
            daily = float(day.get("today_cost", day.get("total_cost", 0.0)) or 0.0)
        except Exception as exc:  # noqa: BLE001
            logger.warning("daily spend read failed (%s); assuming $0", exc)
        try:
            month = await self._usage.summary(window_hours=_MONTHLY_HOURS)
            monthly = float(month.get("total_cost", 0.0) or 0.0)
        except Exception as exc:  # noqa: BLE001
            logger.warning("monthly spend read failed (%s); assuming $0", exc)
        return {"daily": daily, "monthly": monthly}

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
