"""The auto-close review ledger (Round 15 SPEC D6.4).

A small, random, capped sample of the cases the AI agent closed automatically is sent
to a person for review (``engine.auto_close_review``). This store keeps the one record
of that sample: which cases were picked, when, under which rule, and how each review
came out. It is human workflow and observability data only: it never feeds
``case_manager.decide()`` (#3), it is never read by a model (#7, #9; the import ban in
``tests/test_round15_wp5_auto_close_review.py``) and it never changes a case.

Storage (the zero-migration KV pattern, #12; no new index, table or migration): ONE
strict compare-and-set document, ``(AUTO_CLOSE_REVIEW_NS, "ledger")``, with a fixed set
of four top-level fields (``acr_store``, ``acr_schema``, ``acr_json`` and the KV
``_rev``). Everything it holds sits inside ``acr_json``, one canonical JSON string, so
case ids, rule names and dates never become Elasticsearch field names:

* ``entries``: a ring of at most :data:`LEDGER_MAX_ENTRIES` sampled cases
  (:class:`ReviewEntry`), oldest first. When it is full, the oldest completed or
  expired entries are dropped first, then the oldest pending ones.
* ``days``: per operator day, how many cases were sampled overall and per rule, for
  :data:`DAY_COUNTS_DAYS` days (the daily and per-rule caps read it).
* ``evicted_through``: the newest sample time among the entries the ring has dropped
  (absent until it drops one), so a metrics window that starts after it is known to
  hold every sample, and one that starts at or before it reports "at least".

The document is written only when a case is sampled or reviewed. ``pending`` and
``completed`` are stored; ``expired`` is computed on read from the configured expiry.

Reads are cheap (Round 16, WP06). At its 2,000-entry bound the document is about 750 KB
and decoding it took about 15 ms, once or more per case open. The store keeps the last
decoded ledger with the exact revision and stored text it came from, and decodes again
only when either differs (a write by this store, by another store instance or by
another process moves the revision; a purge that restarts the revision changes the
text). Every :meth:`AutoCloseReviewStore.load` still returns its own copy, so a caller
that changes its ledger never changes the memo, and the strict compare-and-set write
stays the only authority. A decoded ledger also indexes its entries by case id once,
so :meth:`ReviewLedger.entry_for_case` is a dictionary lookup.

The Demo stack has its own instance over the Demo KV. The cases-tier reset clears it
(receipt ``kv:auto_close_review:<n>``), the factory reset purges the KV wholesale, and
the data export lists its entries.
"""

from __future__ import annotations

import asyncio
import copy
import json
import logging
import math
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from ..constants import AUTO_CLOSE_REVIEW_NS

logger = logging.getLogger("tlsoc.stores.auto_close_review")

#: The one ledger document's key in :data:`~app.constants.AUTO_CLOSE_REVIEW_NS`.
LEDGER_KEY = "ledger"
#: The store tag every ledger document carries (counted in the six-field budget).
STORE_FIELD = "acr_store"
SCHEMA_FIELD = "acr_schema"
JSON_FIELD = "acr_json"
LEDGER_SCHEMA = 1
#: The ring of sampled cases holds at most this many entries.
LEDGER_MAX_ENTRIES = 2000
#: Per-day sampled counts are kept for this many operator days.
DAY_COUNTS_DAYS = 90
#: Compare-and-set attempts before a write gives up.
CAS_RETRIES = 8

STATE_PENDING = "pending"
STATE_COMPLETED = "completed"
STATE_EXPIRED = "expired"
STORED_STATES = (STATE_PENDING, STATE_COMPLETED)

#: Bounds on the plain text an entry carries (defence in depth; the writers bound too).
_MAX_ID = 128
_MAX_RULE = 256
_MAX_NAME = 128
_MAX_TS = 64


class ReviewLedgerUnavailable(RuntimeError):
    """The ledger could not be read or written (an outage, or a malformed document)."""


def _text(value: Any, limit: int) -> str:
    return value.strip()[:limit] if isinstance(value, str) else ""


def _parse_ts(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


@dataclass
class ReviewEntry:
    """One sampled case and, once a person reviewed it, the review's outcome.

    ``score`` is the case's deterministic sample score, ``day`` the operator day it
    was sampled on and ``rule`` its rule identity. ``classification`` is the
    reviewer's own answer (``true_positive``, ``false_positive``, ``benign`` or
    ``unsure``) and ``agrees`` whether it matches the AI verdict snapshotted when the
    case was sampled (``None`` for ``unsure``). ``elapsed_ms`` is the time the
    reviewer spent, measured by the Console from opening the review card to submitting
    it (``None`` when the client sent none)."""

    review_id: str
    case_id: str
    case_number: str = ""
    rule: str = ""
    sampled_at: str = ""
    day: str = ""
    score: float = 0.0
    state: str = STATE_PENDING
    reviewer: str = ""
    completed_at: str = ""
    classification: str = ""
    agrees: bool | None = None
    ai_verdict: str = ""
    elapsed_ms: int | None = None

    @classmethod
    def from_doc(cls, raw: Any) -> "ReviewEntry | None":
        """A stored entry, or None when it lacks an id or a case (skipped, never an
        error)."""
        if not isinstance(raw, dict):
            return None
        review_id = _text(raw.get("review_id"), _MAX_ID)
        case_id = _text(raw.get("case_id"), _MAX_ID)
        if not review_id or not case_id:
            return None
        score = raw.get("score")
        try:
            score_value = float(score) if not isinstance(score, bool) else 0.0
        except (TypeError, ValueError):
            score_value = 0.0
        if not math.isfinite(score_value):
            score_value = 0.0
        state = raw.get("state")
        agrees = raw.get("agrees")
        elapsed = raw.get("elapsed_ms")
        return cls(
            review_id=review_id,
            case_id=case_id,
            case_number=_text(raw.get("case_number"), _MAX_ID),
            rule=_text(raw.get("rule"), _MAX_RULE),
            sampled_at=_text(raw.get("sampled_at"), _MAX_TS),
            day=_text(raw.get("day"), 10),
            score=score_value,
            state=state if state in STORED_STATES else STATE_PENDING,
            reviewer=_text(raw.get("reviewer"), _MAX_NAME),
            completed_at=_text(raw.get("completed_at"), _MAX_TS),
            classification=_text(raw.get("classification"), 32),
            agrees=agrees if isinstance(agrees, bool) else None,
            ai_verdict=_text(raw.get("ai_verdict"), 32),
            elapsed_ms=(
                int(elapsed) if isinstance(elapsed, int) and not isinstance(elapsed, bool)
                and 0 <= elapsed <= 86_400_000 else None
            ),
        )

    def to_doc(self) -> dict[str, Any]:
        return asdict(self)

    def sampled_instant(self) -> datetime | None:
        return _parse_ts(self.sampled_at)

    def completed_instant(self) -> datetime | None:
        return _parse_ts(self.completed_at)

    def state_at(self, now: datetime, expiry_days: int) -> str:
        """``completed``, ``pending`` or (a pending entry older than ``expiry_days``)
        ``expired``. An entry whose sample time cannot be read stays pending."""
        if self.state == STATE_COMPLETED:
            return STATE_COMPLETED
        sampled = self.sampled_instant()
        if sampled is not None and now >= sampled + timedelta(days=max(1, int(expiry_days))):
            return STATE_EXPIRED
        return STATE_PENDING


@dataclass
class ReviewLedger:
    """The decoded ledger: the entry ring (oldest first), the per-day counts
    (``{day: {"n": int, "rules": {rule: int}}}``), the eviction watermark
    (``evicted_through``, the newest sample time the ring has dropped, ISO text or
    empty) and the document revision."""

    entries: list[ReviewEntry] = field(default_factory=list)
    days: dict[str, dict[str, Any]] = field(default_factory=dict)
    rev: int = 0
    evicted_through: str = ""
    # The case id to newest entry index, built on first use and rebuilt whenever the
    # entry list is no longer the one it was built from (replaced, grown, shrunk, or
    # its first or last entry swapped). Never stored, compared or printed.
    _case_index: dict[str, ReviewEntry] | None = field(
        default=None, init=False, repr=False, compare=False,
    )
    _case_index_mark: tuple[int, int, int, int] | None = field(
        default=None, init=False, repr=False, compare=False,
    )

    # -- reads ------------------------------------------------------------------ #
    def _entries_mark(self) -> tuple[int, int, int, int]:
        entries = self.entries
        if not entries:
            return (id(entries), 0, 0, 0)
        return (id(entries), len(entries), id(entries[0]), id(entries[-1]))

    def _index(self) -> dict[str, ReviewEntry]:
        mark = self._entries_mark()
        if self._case_index is None or self._case_index_mark != mark:
            index: dict[str, ReviewEntry] = {}
            for entry in self.entries:  # oldest first, so the newest entry wins
                index[entry.case_id] = entry
            self._case_index = index
            self._case_index_mark = mark
        return self._case_index

    def entry_for_case(self, case_id: str) -> ReviewEntry | None:
        """The newest entry of ``case_id``, or None (one dictionary lookup)."""
        entry = self._index().get(case_id)
        if entry is not None and entry.case_id == case_id:
            return entry
        if entry is None:
            return None
        # An entry was changed in place after the index was built: read the list.
        self._case_index = None
        for candidate in reversed(self.entries):
            if candidate.case_id == case_id:
                return candidate
        return None

    def entry_by_id(self, review_id: str) -> ReviewEntry | None:
        for entry in self.entries:
            if entry.review_id == review_id:
                return entry
        return None

    def day_count(self, day: str) -> int:
        bucket = self.days.get(day) or {}
        try:
            return max(0, int(bucket.get("n", 0)))
        except (TypeError, ValueError):
            return 0

    def rule_count(self, day: str, rule: str) -> int:
        bucket = self.days.get(day) or {}
        rules = bucket.get("rules") if isinstance(bucket.get("rules"), dict) else {}
        try:
            return max(0, int(rules.get(rule, 0)))
        except (TypeError, ValueError):
            return 0

    def oldest_day(self) -> str | None:
        return min(self.days) if self.days else None

    def evicted_instant(self) -> datetime | None:
        """The newest sample time among the dropped entries, or None when the ring has
        never dropped one."""
        return _parse_ts(self.evicted_through)

    # -- transitions (pure; callers run them inside :meth:`AutoCloseReviewStore.update`) #
    def add(self, entry: ReviewEntry, *, now: datetime, expiry_days: int) -> None:
        """Append ``entry``, count it on its day (overall and for its rule), then keep
        the ring within :data:`LEDGER_MAX_ENTRIES` and the counts within
        :data:`DAY_COUNTS_DAYS` days."""
        self.entries.append(entry)
        bucket = self.days.setdefault(entry.day, {"n": 0, "rules": {}})
        bucket["n"] = self.day_count(entry.day) + 1
        rules = bucket.get("rules") if isinstance(bucket.get("rules"), dict) else {}
        rules[entry.rule] = self.rule_count(entry.day, entry.rule) + 1
        bucket["rules"] = rules
        self.evict(now=now, expiry_days=expiry_days)

    def evict(self, *, now: datetime, expiry_days: int) -> int:
        """Drop entries beyond :data:`LEDGER_MAX_ENTRIES`, the oldest completed or
        expired first, then the oldest pending; and day counts older than
        :data:`DAY_COUNTS_DAYS` days. Returns how many entries were dropped."""
        dropped = 0
        overflow = len(self.entries) - LEDGER_MAX_ENTRIES
        if overflow > 0:
            settled = [
                index for index, entry in enumerate(self.entries)
                if entry.state_at(now, expiry_days) != STATE_PENDING
            ]
            remove = set(settled[:overflow])
            if len(remove) < overflow:
                pending = [i for i in range(len(self.entries)) if i not in remove]
                remove.update(pending[: overflow - len(remove)])
            # Settled entries go first, so a dropped entry can be NEWER than the oldest
            # kept one: the watermark records the newest dropped sample time.
            newest = self.evicted_instant()
            for index in remove:
                at = self.entries[index].sampled_instant()
                if at is not None and (newest is None or at > newest):
                    newest = at
            if newest is not None:
                self.evicted_through = newest.astimezone(timezone.utc).isoformat()
            self.entries = [e for i, e in enumerate(self.entries) if i not in remove]
            dropped = len(remove)
        cutoff = (now - timedelta(days=DAY_COUNTS_DAYS)).date().isoformat()
        for day in [d for d in self.days if d < cutoff]:
            del self.days[day]
        return dropped

    # -- codec ------------------------------------------------------------------ #
    @classmethod
    def from_doc(cls, doc: dict[str, Any] | None) -> "ReviewLedger":
        """The stored ledger (an absent document is an empty ledger). Raises
        :class:`ReviewLedgerUnavailable` for a document that is not a ledger."""
        if doc is None:
            return cls()
        if not isinstance(doc, dict):
            raise ReviewLedgerUnavailable("The auto-close review ledger is not a document.")
        try:
            rev = max(0, int(doc.get("_rev", 0) or 0))
        except (TypeError, ValueError):
            rev = 0
        raw = doc.get(JSON_FIELD)
        if raw in (None, ""):
            return cls(rev=rev)
        if not isinstance(raw, str):
            raise ReviewLedgerUnavailable("The auto-close review ledger is malformed.")
        try:
            parsed = json.loads(raw)
        except ValueError as exc:
            raise ReviewLedgerUnavailable("The auto-close review ledger is malformed.") from exc
        if not isinstance(parsed, dict):
            raise ReviewLedgerUnavailable("The auto-close review ledger is malformed.")
        entries = [
            entry for entry in (ReviewEntry.from_doc(item) for item in parsed.get("entries") or [])
            if entry is not None
        ]
        days: dict[str, dict[str, Any]] = {}
        for day, bucket in (parsed.get("days") or {}).items():
            if not isinstance(day, str) or not isinstance(bucket, dict):
                continue
            rules = bucket.get("rules") if isinstance(bucket.get("rules"), dict) else {}
            clean_rules: dict[str, int] = {}
            for rule, count in rules.items():
                if isinstance(rule, str) and isinstance(count, int) and not isinstance(count, bool):
                    clean_rules[rule[:_MAX_RULE]] = max(0, count)
            n = bucket.get("n")
            days[day[:10]] = {
                "n": max(0, n) if isinstance(n, int) and not isinstance(n, bool) else 0,
                "rules": clean_rules,
            }
        evicted = _text(parsed.get("evicted_through"), _MAX_TS)
        return cls(
            entries=entries, days=days, rev=rev,
            evicted_through=evicted if _parse_ts(evicted) is not None else "",
        )

    def to_json(self) -> str:
        """The canonical stored form (sorted keys, no spaces)."""
        payload: dict[str, Any] = {
            "schema": LEDGER_SCHEMA,
            "entries": [entry.to_doc() for entry in self.entries],
            "days": self.days,
        }
        if self.evicted_through:
            payload["evicted_through"] = self.evicted_through
        return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)

    def to_doc(self) -> dict[str, Any]:
        return {
            STORE_FIELD: AUTO_CLOSE_REVIEW_NS,
            SCHEMA_FIELD: LEDGER_SCHEMA,
            JSON_FIELD: self.to_json(),
        }

    def copy(self) -> "ReviewLedger":
        return ReviewLedger(
            entries=[copy.copy(entry) for entry in self.entries],
            days=copy.deepcopy(self.days),
            rev=self.rev,
            evicted_through=self.evicted_through,
        )


class AutoCloseReviewStore:
    """The strict compare-and-set ledger over one KV (the real KV, or the Demo
    stack's). One instance per KV and stack; its lock serialises every in-process
    write, and the ``_rev`` compare-and-set covers another process."""

    def __init__(self, kv: Any) -> None:
        self.kv = kv
        self.lock = asyncio.Lock()
        # The last decoded ledger: ``(revision, stored JSON text, ledger)``. Read only
        # through :meth:`_decode`, which hands out copies.
        self._memo: tuple[int, Any, ReviewLedger] | None = None
        #: How many times this store decoded the stored ledger (observability, tests).
        self.decodes = 0

    async def _get(self) -> dict[str, Any] | None:
        getter = getattr(self.kv, "get_strict", None) or self.kv.get
        try:
            value = await getter(AUTO_CLOSE_REVIEW_NS, LEDGER_KEY)
        except Exception as exc:  # noqa: BLE001 (an outage is reported, never guessed)
            raise ReviewLedgerUnavailable("The auto-close review ledger could not be read.") from exc
        return copy.deepcopy(value)

    async def _put_if(self, value: dict[str, Any], expected_rev: int) -> bool:
        writer = getattr(self.kv, "put_if_strict", None) or getattr(self.kv, "put_if", None)
        if writer is None:
            raise ReviewLedgerUnavailable("The KV store has no compare-and-set.")
        try:
            return bool(await writer(AUTO_CLOSE_REVIEW_NS, LEDGER_KEY, value, expected_rev))
        except Exception as exc:  # noqa: BLE001
            raise ReviewLedgerUnavailable("The auto-close review ledger could not be saved.") from exc

    def _decode(self, doc: dict[str, Any] | None) -> ReviewLedger:
        """``doc`` as a ledger, decoded at most once per (revision, stored text). The
        memo is never handed out: the caller gets a copy."""
        if not isinstance(doc, dict):
            return ReviewLedger.from_doc(doc)
        raw = doc.get(JSON_FIELD)
        try:
            rev = max(0, int(doc.get("_rev", 0) or 0))
        except (TypeError, ValueError):
            rev = 0
        memo = self._memo
        if memo is not None and memo[0] == rev and type(memo[1]) is type(raw) and memo[1] == raw:
            return memo[2].copy()
        ledger = ReviewLedger.from_doc(doc)
        self.decodes += 1
        self._memo = (rev, raw, ledger.copy())
        return ledger

    def _remember(self, ledger: ReviewLedger, raw: str) -> None:
        """Keep the ledger this store just wrote (its revision and exact text) as the
        memo, so the next read decodes nothing."""
        self._memo = (int(ledger.rev), raw, ledger.copy())

    async def load(self) -> ReviewLedger:
        """The ledger as stored now (a fresh copy the caller may change). Raises
        :class:`ReviewLedgerUnavailable`."""
        return self._decode(await self._get())

    async def update(
        self,
        change: Callable[[ReviewLedger], ReviewLedger | None],
        *,
        locked: bool = False,
    ) -> ReviewLedger | None:
        """Apply ``change`` (a pure transition of a fresh copy; it may run more than
        once) with strict compare-and-set. ``change`` returns ``None`` to write
        nothing. Returns the saved ledger, or ``None`` when nothing was written.
        ``locked=True`` when the caller already holds :attr:`lock`. Raises
        :class:`ReviewLedgerUnavailable` on an outage or after
        :data:`CAS_RETRIES` conflicts."""
        if locked:
            return await self._update(change)
        async with self.lock:
            return await self._update(change)

    async def _update(
        self, change: Callable[[ReviewLedger], ReviewLedger | None],
    ) -> ReviewLedger | None:
        for _attempt in range(CAS_RETRIES):
            current = await self.load()
            proposed = change(current.copy())
            if proposed is None:
                return None
            doc = proposed.to_doc()
            doc["_rev"] = current.rev + 1
            if await self._put_if(doc, current.rev):
                proposed.rev = current.rev + 1
                self._remember(proposed, doc[JSON_FIELD])
                return proposed
        raise ReviewLedgerUnavailable("The auto-close review ledger changed too quickly; retry.")

    async def clear(self) -> int:
        """Empty the ledger (the cases-tier reset). Returns how many entries it held."""
        removed = {"n": 0}

        def _empty(ledger: ReviewLedger) -> ReviewLedger | None:
            removed["n"] = len(ledger.entries)
            if not ledger.entries and not ledger.days:
                return None
            return ReviewLedger()

        await self.update(_empty)
        return removed["n"]

    async def export_rows(self) -> list[dict[str, Any]]:
        """Every entry as plain data, oldest first, for the data export (metadata
        only: ids, the rule, times, states and the review's codes; never a note)."""
        ledger = await self.load()
        return [entry.to_doc() for entry in ledger.entries]


__all__ = [
    "CAS_RETRIES",
    "DAY_COUNTS_DAYS",
    "JSON_FIELD",
    "LEDGER_KEY",
    "LEDGER_MAX_ENTRIES",
    "LEDGER_SCHEMA",
    "SCHEMA_FIELD",
    "STATE_COMPLETED",
    "STATE_EXPIRED",
    "STATE_PENDING",
    "STORE_FIELD",
    "AutoCloseReviewStore",
    "ReviewEntry",
    "ReviewLedger",
    "ReviewLedgerUnavailable",
]
