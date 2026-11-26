"""Cost figures inside recorded audit text (Round 16, WP16).

A few audit writers put a spend figure into a row's ``result_summary``: the
investigation timeout row (``partial cost=0.0123``), the case manager's DECISION row
(``cost=0.0123``), the runbook AI prompt row (``cost=0.004000``) and a budget refusal
(``daily spend $1.2345 + est $0.0100 would exceed the $10.00 daily ceiling``). The case
reads that show those rows (the trace, the timeline spans and their details, the
rationale, the case activity feed and chat's case rationale) are open to every
``cases:read`` holder, while AI spend follows one rule,
``cost:view``. For a caller without it, :func:`withhold_cost_text` replaces each figure
with plain words, so the row still reads and the amount is not shown.

Only the rows those writers make are changed (:func:`withhold_row_cost_text`, the action
types in :data:`COST_TEXT_ACTIONS`). Every other row, and every tool output, is case
evidence and is shown as it was recorded: a log line such as ``awk '{print $1}'`` or
``amount=$500`` is never rewritten.

Read-time display only: the stored audit rows never change (#2), and nothing here is
read by ``decide()`` (#3).
"""

from __future__ import annotations

import re
from typing import Any

#: ``cost=0.0123``, ``partial cost=1e-05``, ``cost=$0.01``.
_COST_ASSIGNMENT = re.compile(r"(?i)\b(cost)\s*=\s*\$?\s*-?\d[\d,]*(?:\.\d+)?(?:e[-+]?\d+)?")
#: ``$1.2345``, ``$ 10.00``, ``-$0.5``.
_DOLLAR_AMOUNT = re.compile(r"-?\$\s?\d[\d,]*(?:\.\d+)?(?:e[-+]?\d+)?")

#: What a withheld figure reads as.
COST_HIDDEN = "hidden"
AMOUNT_HIDDEN = "(amount hidden)"


def withhold_cost_text(text: Any) -> Any:
    """``text`` with every cost figure replaced: ``cost=0.0123`` reads ``cost=hidden``
    and ``$1.23`` reads ``(amount hidden)``. A value that is not a string is returned as
    it is (``None`` stays ``None``)."""
    if not isinstance(text, str) or not text:
        return text
    out = _COST_ASSIGNMENT.sub(lambda m: f"{m.group(1)}={COST_HIDDEN}", text)
    return _DOLLAR_AMOUNT.sub(AMOUNT_HIDDEN, out)


#: The audit action types whose writers put a spend figure into ``result_summary``:
#: the timeout row and a budget refusal (``error``), the case manager's row
#: (``decision``) and the runbook AI row (``prompt``).
COST_TEXT_ACTIONS: frozenset[str] = frozenset({"error", "decision", "prompt"})


def withhold_row_cost_text(action_type: Any, text: Any) -> Any:
    """A row's ``result_summary`` with its cost figures withheld when the row is one a
    spend writer makes (:data:`COST_TEXT_ACTIONS`); any other row's text is returned as
    it is, so evidence that happens to hold a ``$`` or ``cost=`` is never changed."""
    kind = str(getattr(action_type, "value", action_type) or "").strip().lower()
    if kind not in COST_TEXT_ACTIONS:
        return text
    return withhold_cost_text(text)


__all__ = [
    "AMOUNT_HIDDEN", "COST_HIDDEN", "COST_TEXT_ACTIONS", "withhold_cost_text",
    "withhold_row_cost_text",
]
