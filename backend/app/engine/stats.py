"""Shared pure statistics (Round 16 SPEC §4.5 WP10, research explainability R10).

One Wilson score interval for every caller: the threshold tuner (its unrounded lower
bound decides whether a rule clears the false-positive target), the auto-close review
summary and the agent improvement comparison (both round the interval to 4 decimals at
their own call sites). One implementation means the explanation a person reads and the
number the code compared cannot drift apart.

Pure and synchronous: no I/O, no clock, no model call (#6). Nothing here decides a
case: this module imports nothing from ``engine/case_manager.py`` (the §3.6 guard), and
no caller passes its output to ``decide()`` (#3).
"""

from __future__ import annotations

import math

#: The z value of a two-sided 95% interval.
WILSON_Z_95 = 1.96


def wilson_interval(successes: float, n: int, *, z: float = WILSON_Z_95) -> tuple[float, float] | None:
    """The Wilson score interval ``(low, high)`` of ``successes`` out of ``n``, unrounded,
    each bound clamped to ``0..1``; ``None`` when ``n`` is 0 or less.

    With ``p = successes / n``:

    * ``centre = p + z^2 / (2n)``;
    * ``margin = z * sqrt((p * (1 - p) + z^2 / (4n)) / n)``;
    * ``low = (centre - margin) / (1 + z^2 / n)`` and ``high = (centre + margin) / (1 + z^2 / n)``.

    The operations run in the threshold tuner's order, so its lower bound is the same
    float it always was; a caller that shows the interval rounds it itself."""
    if n <= 0:
        return None
    phat = successes / n
    z2 = z * z
    denom = 1.0 + z2 / n
    centre = phat + z2 / (2 * n)
    margin = z * math.sqrt((phat * (1 - phat) + z2 / (4 * n)) / n)
    low = (centre - margin) / denom
    high = (centre + margin) / denom
    return max(0.0, min(1.0, low)), max(0.0, min(1.0, high))


__all__ = ["WILSON_Z_95", "wilson_interval"]
