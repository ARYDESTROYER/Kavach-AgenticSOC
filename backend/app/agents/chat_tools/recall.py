"""``recall_observation``: read back an earlier observation of the SAME turn (Round 12,
SPEC D4 intra-turn compaction).

When a long investigation's prompt passes about 60 % of the model's context window,
the engine shortens the observations of older lookup batches to their TRUSTED result
lines (the ``Tool call tN … — artifacts: …`` header with its artifact manifest). The
full observation is kept in the turn's :class:`ObservationStore`, and this read-only
lookup returns it again on request.

What it returns is exactly what the model already saw for that call: the tool's own
aggregated, whitelisted observation after the structural shrink, fenced as UNTRUSTED
by the engine (#9). It never returns an artifact (the deterministic data behind answer
blocks, e.g. a log table's rows) and never reads a store or a log source, so it cannot
widen what the model sees (#7: aggregates only, never raw log rows) and needs no grant
of its own: every observation in the store came from a lookup the caller was already
allowed to run in this turn.

The tool is dispatched by the chat engine itself (it needs the turn's store), not by
the registry's catalogue, so it never appears in ``/api/chat/context`` or in the
tool signatures of an ordinary prompt; the engine's compaction note names it when it
becomes useful.
"""

from __future__ import annotations

import copy
import re
from dataclasses import dataclass, field
from typing import Any

from ..chat_events import RECALL_TOOL

NAME = RECALL_TOOL
LABEL = "Re-read an earlier lookup result"
RUNNING_LABEL = "Re-reading an earlier lookup result"
SIGNATURE = f"{NAME}(ref) -- read again the full result of an earlier lookup of this question (ref: t3)"
DISPLAY_KEYS = ("ref",)

# ``t3`` or an artifact ref of that call, ``t3.a1`` (the call's whole observation is
# returned either way; artifacts are never returned).
_REF_RE = re.compile(r"^t([1-9][0-9]{0,2})(?:\.a[1-9][0-9]{0,2})?$")

NOT_FOUND = "No earlier lookup result with that ref in this question"
BAD_REF = "Give the ref of an earlier lookup of this question, such as t3"


@dataclass
class StoredObservation:
    """One call's observation as the model saw it (after the structural shrink)."""

    ordinal: int
    tool: str
    observation: dict[str, Any]
    summary: str = ""
    untrusted_params: dict[str, str] = field(default_factory=dict)


class ObservationStore:
    """The turn's observations by call ordinal (owned by the engine, one per turn)."""

    def __init__(self) -> None:
        self._items: dict[int, StoredObservation] = {}

    def put(self, item: StoredObservation) -> None:
        self._items[item.ordinal] = item

    def get(self, ordinal: int) -> StoredObservation | None:
        return self._items.get(ordinal)

    def __contains__(self, ordinal: object) -> bool:
        return ordinal in self._items

    def __len__(self) -> int:
        return len(self._items)


def parse_ref(value: Any) -> int | None:
    """The call ordinal of ``t3`` / ``t3.a1``; ``None`` for anything else."""
    if not isinstance(value, str):
        return None
    match = _REF_RE.match(value.strip())
    return int(match.group(1)) if match else None


@dataclass(frozen=True)
class RecallResult:
    """What the engine renders for one ``recall_observation`` call."""

    ok: bool
    summary: str
    item: StoredObservation | None = None


def recall(store: ObservationStore, inp: Any) -> RecallResult:
    """Look ``inp["ref"]`` up in ``store``. Engine-template summaries only."""
    ref = inp.get("ref") if isinstance(inp, dict) else None
    ordinal = parse_ref(ref)
    if ordinal is None:
        return RecallResult(ok=False, summary=BAD_REF)
    item = store.get(ordinal)
    if item is None:
        return RecallResult(ok=False, summary=NOT_FOUND)
    copied = StoredObservation(
        ordinal=item.ordinal, tool=item.tool, observation=copy.deepcopy(item.observation),
        summary=item.summary, untrusted_params=dict(item.untrusted_params),
    )
    return RecallResult(ok=True, summary=f"Result of t{item.ordinal} {item.tool}", item=copied)


def display_params(inp: Any) -> dict[str, Any]:
    """The run-log chip: the ref, when it is a well-formed one."""
    ref = inp.get("ref") if isinstance(inp, dict) else None
    ordinal = parse_ref(ref)
    return {"ref": f"t{ordinal}"} if ordinal is not None else {}
