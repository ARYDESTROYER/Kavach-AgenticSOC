"""Durable, case-scoped precedent EXCLUSION markers — making a delete stay deleted.

Force-deleting a ``resolved_case`` document removes its chunks, and then the next
ordinary projection re-derives that precedent straight from the case store and puts it
back. The operator's curation action silently undoes itself, and nothing anywhere
reports that it did. Until now the only way to make a deletion stick was to destroy the
analyst's own label on the case — which is audit-hostile, rewrites ground truth, and
corrupts the threshold tuner's independent-evidence count, which is derived from exactly
those labels.

This store is the supported alternative: a small, bounded set of case ids the precedent
PROJECTION must skip, held as ONE JSON document through the existing
:class:`~app.stores.base.KVStore` abstraction. Like
:mod:`app.stores.rag_health` and :mod:`app.stores.noise_counters` it needs **no new ES
index, no SQL table and no migration** — the ES backend keeps it in the config index and
the SQL backend in the shared KV table — and every write goes through the shared
compare-and-set :meth:`~app.stores.base.KVStore.mutate` helper, so lost-update behaviour
is identical on every backend.

Invariants, all load-bearing:

* **Never ground truth.** A marker says "do not PROJECT this case as precedent". It does
  not touch ``status``, ``disposition``, ``decision_by``, ``feedback``, ``history`` or
  any analyst label, so ``engine.analyst_outcomes.analyst_confirmed_outcome`` still
  returns exactly what it returned before and the tuner's independent-evidence count is
  unchanged. Excluding is a CORPUS curation act, not a re-labelling.
* **Never model-facing (#9).** The ``reason`` and the free-text ``note`` are UI/audit
  fields. They are never rendered into a corpus chunk and never reach a prompt; the note
  is control-character-stripped and length-bounded on the way in regardless.
* **Never a decision input (#3).** Nothing here is read by ``case_manager.decide()``.
* **Bounded RELATIVE to the configured precedent window**, never by a constant: an
  exclusion set several windows deep means the corpus itself is wrong and wants a policy
  change, not a longer hand-maintained deny list. The caller supplies the bound it
  derived from ``prefs.precedent.window.size``.

The stored document is::

    {"cases": {"<case_id>": {"reason": "<enum>", "note": str, "actor": str,
                             "at": "<iso>", "rule_identity": str}},
     "_rev": n}
"""

from __future__ import annotations

import logging
import re
from typing import Any

from ..utils import iso_now
from .base import KVStore

logger = logging.getLogger("tlsoc.stores.precedent_exclusions")

# Namespace/key are defined HERE rather than in ``constants.py`` on purpose: this is a
# self-contained single-document store with exactly one reader and one writer, and the
# shared constants module is a high-traffic file. The literals are part of the durable
# contract — never rename them without a migration path.
PRECEDENT_EXCLUSION_NS = "precedent_exclusions"
PRECEDENT_EXCLUSION_KEY = "precedent_exclusions"

# The BOUNDED reason vocabulary. Free text is confined to ``note``; the reason itself is
# a closed enum so the diagnostics/per-rule breakdown can group by it and so no operator
# phrasing can ever become a de-facto schema. Deliberately product-generic — none of
# these names encodes a vendor, a detection product or one deployment's workflow.
PRECEDENT_EXCLUSION_REASONS: tuple[str, ...] = (
    # The recorded outcome does not describe what actually happened on the case.
    "mislabelled",
    # Arrived through a BULK ratification of model verdicts rather than analyst review.
    "ratification_artifact",
    # The same fact is already represented by another precedent record.
    "duplicate",
    # A later decision replaced it; keeping it retrievable teaches the stale answer.
    "superseded",
    # Must not appear in retrieved context at all.
    "sensitive",
    # Anything else; ``note`` carries the detail.
    "other",
)
DEFAULT_EXCLUSION_REASON = "other"

# Control characters (incl. newlines/tabs) never survive into a stored note. The note is
# not model-facing, but an operator-authored field that is replayed into a JSON API and
# an operator console has no business carrying them either.
_CONTROL_CHARS_RE = re.compile(r"[\x00-\x1f\x7f-\x9f]")

_NOTE_MAX_CHARS = 280
_ACTOR_MAX_CHARS = 120
_CASE_ID_MAX_CHARS = 120
_RULE_IDENTITY_MAX_CHARS = 400


def normalise_reason(value: Any) -> str:
    """Coerce a caller-supplied reason onto the bounded enum. Never raises."""
    candidate = str(value or "").strip().lower()
    return candidate if candidate in PRECEDENT_EXCLUSION_REASONS else DEFAULT_EXCLUSION_REASON


def normalise_note(value: Any) -> str:
    """Strip control characters, collapse whitespace, and bound the length."""
    text = _CONTROL_CHARS_RE.sub(" ", str(value or ""))
    text = " ".join(text.split())
    if len(text) > _NOTE_MAX_CHARS:
        text = text[: _NOTE_MAX_CHARS - 1].rstrip() + "…"
    return text


def _clean_entry(raw: Any) -> dict[str, Any] | None:
    """Normalise one persisted row, or ``None`` when it is unusable."""
    if not isinstance(raw, dict):
        return None
    return {
        "reason": normalise_reason(raw.get("reason")),
        "note": normalise_note(raw.get("note")),
        "actor": str(raw.get("actor") or "")[:_ACTOR_MAX_CHARS],
        "at": str(raw.get("at") or ""),
        "rule_identity": str(raw.get("rule_identity") or "")[:_RULE_IDENTITY_MAX_CHARS],
    }


class PrecedentExclusionStore:
    """Fail-open persistence for the case-scoped precedent exclusion set.

    Reads degrade to "unreadable" rather than to "empty": the caller distinguishes the
    two, because silently reporting an unreadable exclusion set as no exclusions would
    resurrect every excluded precedent on the next projection — the exact failure this
    store exists to end.
    """

    def __init__(self, kv: KVStore) -> None:
        self._kv = kv

    async def load(self) -> dict[str, dict[str, Any]] | None:
        """The exclusion map, or ``None`` when the store could not be READ.

        ``{}`` and ``None`` are different answers and are never conflated.
        """
        try:
            doc = await self._kv.get(PRECEDENT_EXCLUSION_NS, PRECEDENT_EXCLUSION_KEY)
        except Exception as exc:  # noqa: BLE001 — the caller decides how to degrade
            logger.warning("Precedent exclusion set could not be read: %s", exc)
            return None
        rows = (doc or {}).get("cases")
        out: dict[str, dict[str, Any]] = {}
        if isinstance(rows, dict):
            for case_id, raw in rows.items():
                entry = _clean_entry(raw)
                key = str(case_id or "")[:_CASE_ID_MAX_CHARS]
                if entry is not None and key:
                    out[key] = entry
        return out

    async def exclude(
        self,
        case_id: str,
        *,
        reason: str,
        note: str = "",
        actor: str = "",
        rule_identity: str = "",
        max_entries: int,
    ) -> dict[str, Any]:
        """Record (or refresh) ONE case-scoped exclusion marker.

        Returns ``{"ok", "already", "count", "capped"}``. ``capped`` is True when the
        bound the caller derived from the configured window size is already reached and
        this is a NEW id — refreshing an existing marker is always allowed, so a bounded
        set never becomes uneditable.
        """
        key = str(case_id or "").strip()[:_CASE_ID_MAX_CHARS]
        if not key:
            return {"ok": False, "already": False, "count": 0, "capped": False}
        entry = {
            "reason": normalise_reason(reason),
            "note": normalise_note(note),
            "actor": str(actor or "")[:_ACTOR_MAX_CHARS],
            "at": iso_now(),
            "rule_identity": str(rule_identity or "")[:_RULE_IDENTITY_MAX_CHARS],
        }
        outcome: dict[str, Any] = {"ok": False, "already": False, "count": 0, "capped": False}
        limit = max(1, int(max_entries))

        def _mutate(current: dict[str, Any] | None) -> dict[str, Any]:
            doc = dict(current or {})
            rows = dict(doc.get("cases") or {})
            existed = key in rows
            if not existed and len(rows) >= limit:
                outcome.update(ok=False, already=False, count=len(rows), capped=True)
                return doc
            rows[key] = entry
            doc["cases"] = rows
            outcome.update(ok=True, already=existed, count=len(rows), capped=False)
            return doc

        await self._kv.mutate(PRECEDENT_EXCLUSION_NS, PRECEDENT_EXCLUSION_KEY, _mutate)
        return outcome

    async def restore(self, case_id: str) -> dict[str, Any]:
        """Drop ONE exclusion marker. Returns ``{"ok", "found", "count"}``.

        Restoring removes the marker only. The precedent itself reappears on the next
        ordinary projection, from the case store, exactly as it would have before it was
        excluded — no chunk is written here.
        """
        key = str(case_id or "").strip()[:_CASE_ID_MAX_CHARS]
        outcome: dict[str, Any] = {"ok": False, "found": False, "count": 0}
        if not key:
            return outcome

        def _mutate(current: dict[str, Any] | None) -> dict[str, Any]:
            doc = dict(current or {})
            rows = dict(doc.get("cases") or {})
            found = rows.pop(key, None) is not None
            doc["cases"] = rows
            outcome.update(ok=True, found=found, count=len(rows))
            return doc

        await self._kv.mutate(PRECEDENT_EXCLUSION_NS, PRECEDENT_EXCLUSION_KEY, _mutate)
        return outcome
