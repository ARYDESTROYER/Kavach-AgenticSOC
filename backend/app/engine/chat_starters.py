"""Dynamic chat starters (Round 13, ``docs/research/2026-10-round13/SPEC-chat.md``
Part A): the family registry, ranking, the visit and shift state machine, the
catch-up line and the public builder behind ``GET /api/chat/starters``.

Rules this module keeps (SPEC D1, §3.12, §3.13, §6):

* Deterministic and $0. Code computes, ranks and words every starter from the suite's
  own state under the caller's grants. No model call, no UsageDoc, no log query (#1,
  #6, #7). Wording comes only from ``agents/chat_starter_text.py``.
* Read-only. A build never writes: the per-user starter state document
  (``stores/chat_starters.py``) changes only on ``POST /api/chat/starters/events``.
* Same view as the answer. Every family reads through the ``ChatToolContext`` the
  chat turn builds for this caller (``state.build_chat_tool_context``), and runs only
  when every tool and permission it needs is allowed (``catalogue_infos``), so a card
  never offers a question its answer would refuse. Object scoping on fails closed:
  every case family and the catch-up line are skipped.
* Exact counts or no card. Counts come from ``engine/case_aggregate.aggregate_cases``
  with ``exact`` true, or from the bounded open-case population.
* Isolated failures. Families run concurrently with a per-family timeout; one that
  raises or times out is skipped and logged once, never hiding the others.

Wave 0 (SPEC §7.1) wrote the public contract: the constants, the tables, the
candidate and state types, :func:`evergreen_starters` (complete), :func:`rank`, the
state transitions and a placeholder :func:`build_starters` that serves the evergreen
set. WP-STARTERS-API owns this module and completes the family registry and the
builder.
"""

from __future__ import annotations

import asyncio
import hashlib
import inspect
import json
import logging
import re
import time
import weakref
from dataclasses import dataclass, field, replace
from datetime import datetime, timedelta, timezone
from decimal import ROUND_HALF_UP, Decimal
from typing import TYPE_CHECKING, Any, Awaitable, Callable, Iterable, Literal, Mapping, Sequence

from ..agents import chat_starter_text as text
from ..constants import OPEN_CASE_STATUSES, TERMINAL_CASE_STATUSES
from ..models import (
    ChatCatchUp,
    ChatCatchUpClause,
    ChatStarter,
    ChatStarterRef,
    ChatStartersInfo,
    StarterSurface,
    StarterUrgency,
)

if TYPE_CHECKING:  # pragma: no cover - typing only
    from ..state import AppState

logger = logging.getLogger(__name__)

# --------------------------------------------------------------------------- #
# Module constants (SPEC §3.2.2, §3.3, §3.5, §3.6, §3.13). All thresholds live here.
# --------------------------------------------------------------------------- #
#: The one bounded open-case read per build, shared by every family (newest first).
OPEN_POPULATION_LIMIT = 2_000
#: Per-caller response cache of ``GET /api/chat/starters``.
CACHE_TTL_S = 60
#: ``expires_at = as_of + EXPIRES_AFTER_S`` (the client refetches after it).
EXPIRES_AFTER_S = 120
#: Per-family and whole-build time limits.
FAMILY_TIMEOUT_S = 0.8
BUILD_TIMEOUT_S = 1.5

#: A ``viewed`` event this long after ``last_seen_at`` starts a new visit (§3.6).
VISIT_GAP = timedelta(minutes=30)
#: ... and this long after it starts a shift (D4).
SHIFT_GAP = timedelta(hours=8)
#: The ``home`` catch-up line shows for this long after the visit started.
CATCHUP_WINDOW = timedelta(minutes=60)
#: The ``thread`` catch-up line needs the thread's last answer settled this long ago.
THREAD_SETTLED = timedelta(minutes=30)
#: The shift-start card: a shift started within this long (or no state yet).
SHIFT_START_WINDOW = timedelta(minutes=60)
#: The handoff card: this long after ``shift_started_at`` (inclusive bounds).
HANDOFF_FROM = timedelta(hours=7)
HANDOFF_TO = timedelta(hours=13)
#: ``{h}`` of ``shift_start``: 12, or 24 when the last visit ended over 12 hours ago.
SHIFT_BRIEF_HOURS = 12
SHIFT_BRIEF_LONG_HOURS = 24
#: "Hide for a day" (§3.9).
DISMISS_FOR = timedelta(hours=24)

#: Cards per read: at most this many signals, then evergreen fill to the same total.
MAX_STARTERS = 6
MAX_SIGNALS = 6

#: Ranking (§3.5).
RECENCY_HALF_LIFE_HOURS = 6.0
RECENCY_FLOOR = 0.25
PERSONAL_ASSIGNED = 2.0
PERSONAL_NEW = 1.5
NOVELTY_VIEWS = 3
NOVELTY_FACTOR = 0.3
SCORE_DECIMALS = 4

#: Family thresholds (§3.3).
VOLUME_BASELINE_DAYS = 7
VOLUME_SPIKE_RATIO = 2.0
VOLUME_SPIKE_MIN_DELTA = 5
VOLUME_DROP_MIN_USUAL = 10
VOLUME_DROP_RATIO = 0.5
NOISY_RULE_MIN_CASES = 10
NOISY_RULE_MIN_SHARE = 0.30
HUNT_MIN_CASES = 3
HUNT_WINDOW = timedelta(days=7)
CONTINUE_WINDOW = timedelta(hours=24)
SILENT_URGENT_AFTER = timedelta(hours=1)
CHAT_CAP_WARN_PCT = 80
CRITICAL_RISK = 80
#: The Demo catch-up baseline when the caller has none and the seed exposes no anchor.
DEMO_BASELINE_AGE = timedelta(hours=8)

# --------------------------------------------------------------------------- #
# The family tables (§3.3, §3.5).
# --------------------------------------------------------------------------- #
#: Signal families in the §3.5 table order (the ``FAMILY_ORDER`` tie-break).
FAMILY_ORDER: tuple[str, ...] = (
    "needs_human", "sla", "my_cases", "new_cases", "shift", "silent_source", "volume_change",
    "campaign", "noisy_rule", "approvals", "budget", "continue", "platform", "hunt", "weekly",
    "saved_prompt", "demo",
)
#: Evergreen families (always eligible when their tools are allowed) and onboarding.
EVERGREEN_FAMILIES: tuple[str, ...] = ("triage", "posture", "report", "explain_metric", "learn_app")
ONBOARDING_FAMILIES: tuple[str, ...] = ("connect_source",)
#: Evergreen fill order (§3.5 step 3). A fresh install (no enabled source and no case)
#: puts ``connect_source`` first and drops ``triage`` and ``posture``.
EVERGREEN_ORDER: tuple[str, ...] = ("triage", "posture", "report", "explain_metric", "learn_app")
EVERGREEN_ORDER_AUDITOR: tuple[str, ...] = ("posture", "explain_metric", "report", "learn_app")
ONBOARDING_ORDER: tuple[str, ...] = ("connect_source", "learn_app", "explain_metric", "report")

#: ``base[family]`` (§3.5).
BASE: Mapping[str, int] = {
    "needs_human": 100, "sla": 95, "my_cases": 90, "new_cases": 85, "shift": 80,
    "silent_source": 75, "volume_change": 70, "campaign": 65, "noisy_rule": 60,
    "approvals": 55, "budget": 50, "continue": 45, "platform": 40, "hunt": 35,
    "weekly": 30, "saved_prompt": 25, "demo": 20,
}

#: Role tie-break preferences (§3.5); a custom role has none (score only).
ROLE_PREFERENCES: Mapping[str, tuple[str, ...]] = {
    "analyst_tier1": ("needs_human", "my_cases", "sla", "new_cases"),
    "analyst_tier2": ("volume_change", "campaign", "hunt", "noisy_rule"),
    "soc_manager": ("sla", "volume_change", "shift", "weekly"),
    "responder": ("needs_human", "my_cases"),
    "auditor": ("posture", "explain_metric"),
    "super_admin": ("silent_source", "approvals", "platform", "budget"),
}

FamilyKind = Literal["case", "source", "spend", "time", "personal", "platform", "demo", "evergreen"]


@dataclass(frozen=True)
class FamilyNeeds:
    """What a family needs before it may produce a card (§3.3): every tool allowed for
    the caller (``catalogue_infos``; a kind-gated tool must allow ``kinds[tool]``), every
    ``permissions`` pair granted, and (``kind == "case"``) object scoping off."""

    kind: FamilyKind
    tools: tuple[str, ...] = ()
    permissions: tuple[tuple[str, str], ...] = ()
    kinds: Mapping[str, str] = field(default_factory=dict)


#: §3.3 "Needs" column. Card ``tools`` come from the template (``chat_starter_text``);
#: the precondition is these PLUS the template's tools.
FAMILY_NEEDS: Mapping[str, FamilyNeeds] = {
    "needs_human": FamilyNeeds("case", ("get_case", "explain_decision")),
    "my_cases": FamilyNeeds("case", ("search_cases",)),
    "sla": FamilyNeeds("case", ("shift_report",)),
    "new_cases": FamilyNeeds("case", ("search_cases", "case_stats")),
    "volume_change": FamilyNeeds("case", ("case_stats",)),
    "noisy_rule": FamilyNeeds("case", ("case_stats", "search_cases")),
    "campaign": FamilyNeeds("case", ("list_campaigns", "search_cases")),
    "silent_source": FamilyNeeds("source", ("source_health",), (("sources", "read"),)),
    "budget": FamilyNeeds("spend", ("cost_usage",), (("models", "read"), ("cost", "view"))),
    "shift": FamilyNeeds("time", ("shift_report", "soc_metrics")),
    "weekly": FamilyNeeds("time", ("case_stats", "soc_metrics")),
    "continue": FamilyNeeds("personal"),
    "saved_prompt": FamilyNeeds("personal"),
    "hunt": FamilyNeeds("case", ("mitre_lookup", "log_stats", "search_cases"), (("sources", "read"),)),
    "approvals": FamilyNeeds("platform", ("automation_status",), kinds={"automation_status": "approvals"}),
    "platform": FamilyNeeds("platform", ("soc_metrics",), (("metrics", "view"),),
                            kinds={"soc_metrics": "auto_close_health"}),
    "demo": FamilyNeeds("demo", ("app_help",)),
    "triage": FamilyNeeds("evergreen", ("search_cases",)),
    "posture": FamilyNeeds("evergreen", ("soc_metrics",)),
    "report": FamilyNeeds("evergreen", ("case_stats", "soc_metrics")),
    "explain_metric": FamilyNeeds("evergreen", ("app_help",)),
    "learn_app": FamilyNeeds("evergreen", ("app_help", "app_status")),
    "connect_source": FamilyNeeds("evergreen", ("app_help",)),
}
#: Families skipped when object scoping is on (fail closed, §3.3 "Object scope").
CASE_FAMILIES: frozenset[str] = frozenset(f for f, n in FAMILY_NEEDS.items() if n.kind == "case")


# --------------------------------------------------------------------------- #
# Keys (§3.2.1): opaque to the client.
# --------------------------------------------------------------------------- #
def starter_key(family: str, ref: ChatStarterRef | None = None) -> str:
    """``sha256("<family>|<kind>|<value>")`` (``"<family>|"`` without a reference),
    first 16 hex characters."""
    raw = f"{family}|{ref.kind}|{ref.value}" if ref is not None else f"{family}|"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


# --------------------------------------------------------------------------- #
# Candidates and ranking (§3.5).
# --------------------------------------------------------------------------- #
@dataclass
class StarterCandidate:
    """One family's proposed card before ranking.

    ``urgency`` is the §3.5 multiplier (1.0 to 2.0) and ``urgency_level`` the card's
    ``urgency`` field. ``signal_at`` anchors recency (``None``: recency 1.0).
    ``assigned_to_caller`` / ``newer_than_baseline`` drive ``personal``. ``fallback``
    is the count-only variant used when this card's reference is already named by a
    higher card (one card per reference); ``None`` removes the card instead.
    ``score`` and ``starter.key`` are filled by :func:`rank` / the builder."""

    family: str
    starter: ChatStarter
    urgency: float = 1.0
    urgency_level: StarterUrgency = "none"
    signal_at: datetime | None = None
    assigned_to_caller: bool = False
    newer_than_baseline: bool = False
    fallback: StarterCandidate | None = None
    score: float = 0.0

    @property
    def key(self) -> str:
        return self.starter.key or starter_key(self.family, self.starter.ref)

    @property
    def ref_id(self) -> tuple[str, str] | None:
        ref = self.starter.ref
        return (ref.kind, ref.value) if ref is not None else None


def family_urgency(
    family: str, *, risk: float = 0.0, any_breached: bool = False, past_target: int = 0,
    critical: int = 0, handoff: bool = False, quiet_for: timedelta | None = None,
    ratio: float = 0.0, drop: bool = False, cases: int = 0, pct: float = 0.0,
    needs_input: bool = False,
) -> tuple[float, StarterUrgency]:
    """The §3.5 ``(urgency multiplier, urgency field)`` for ``family`` from its
    measurement (only the arguments the family uses matter)."""
    if family == "needs_human":
        risk = min(max(risk, 0.0), 100.0)
        return 1 + risk / 100, ("critical" if risk >= CRITICAL_RISK else "attention")
    if family == "sla":
        return (2.0, "critical") if any_breached else (1.5, "attention")
    if family == "my_cases":
        return 1 + min(1.0, past_target / 3), ("attention" if past_target >= 1 else "none")
    if family == "new_cases":
        return 1 + min(1.0, critical / 5), ("critical" if critical >= 1 else "none")
    if family == "shift":
        return (1.4 if handoff else 1.5), "none"
    if family == "silent_source":
        urgent = quiet_for is not None and quiet_for >= SILENT_URGENT_AFTER
        return (1.5 if urgent else 1.2), "attention"
    if family == "volume_change":
        return (1.5 if drop else min(2.0, max(1.0, ratio / 2))), "attention"
    if family == "campaign":
        return 1 + min(1.0, cases / 10), "attention"
    if family in ("noisy_rule", "approvals"):
        return 1.2, "none"
    if family == "budget":
        return min(2.0, max(1.0, 1 + (pct - 80) / 20)), "attention"
    if family == "continue":
        return (1.5 if needs_input else 1.0), "none"
    if family == "platform":
        return 1.2, "attention"
    return 1.0, "none"


def _recency(signal_at: datetime | None, now: datetime) -> float:
    if signal_at is None:
        return 1.0
    age_hours = max(0.0, (now - signal_at).total_seconds() / 3600)
    return max(RECENCY_FLOOR, 0.5 ** (age_hours / RECENCY_HALF_LIFE_HOURS))


def _novelty(key: str, user_state: StarterUserState | None) -> float:
    stats = user_state.key_stats(key) if user_state is not None else None
    if stats is not None and stats.views >= NOVELTY_VIEWS and stats.used_at is None:
        return NOVELTY_FACTOR
    return 1.0


def score(candidate: StarterCandidate, *, user_state: StarterUserState | None, now: datetime) -> float:
    """``base * urgency * recency * personal * novelty`` rounded to 4 decimals (§3.5).
    Evergreen and onboarding families have no base and score 0 (they never compete
    with signals)."""
    base = BASE.get(candidate.family)
    if base is None:
        return 0.0
    if candidate.assigned_to_caller:
        personal = PERSONAL_ASSIGNED
    elif candidate.newer_than_baseline:
        personal = PERSONAL_NEW
    else:
        personal = 1.0
    value = (base * candidate.urgency * _recency(candidate.signal_at, now) * personal
             * _novelty(candidate.key, user_state))
    return round(value, SCORE_DECIMALS)


def _role_rank(family: str, role: str) -> int:
    prefs = ROLE_PREFERENCES.get(role, ())
    return prefs.index(family) if family in prefs else len(prefs)


def _family_index(family: str) -> int:
    return FAMILY_ORDER.index(family) if family in FAMILY_ORDER else len(FAMILY_ORDER)


def evergreen_order(role: str, *, fresh_install: bool = False) -> tuple[str, ...]:
    """The evergreen fill order for ``role`` (§3.5 step 3; §3.11 fresh install)."""
    if fresh_install:
        return ONBOARDING_ORDER
    return EVERGREEN_ORDER_AUDITOR if role == "auditor" else EVERGREEN_ORDER


def rank(
    candidates: Iterable[StarterCandidate], *, role: str, user_state: StarterUserState | None,
    now: datetime, fresh_install: bool = False,
) -> list[StarterCandidate]:
    """Order and trim ``candidates`` to the cards a read serves (pure; §3.5).

    1. Drop a family dismissed until a time after ``now``; score the rest.
    2. Signals sort by ``(-score, role_rank, FAMILY_ORDER index, key)``.
    3. One card per family (the first), one card per reference: a card whose
       reference a higher card already names falls back to its count-only variant
       (``fallback``) in place, or is removed.
    4. At most :data:`MAX_SIGNALS` signals, then evergreen cards in the role's order
       (:func:`evergreen_order`) until :data:`MAX_STARTERS` or the set is exhausted.
    """
    dismissed = user_state.dismissed_families(now) if user_state is not None else frozenset()
    signals: list[StarterCandidate] = []
    evergreen: dict[str, StarterCandidate] = {}
    for candidate in candidates:
        if candidate.family in dismissed:
            continue
        if candidate.family in BASE:
            candidate.score = score(candidate, user_state=user_state, now=now)
            signals.append(candidate)
        elif candidate.family in EVERGREEN_FAMILIES or candidate.family in ONBOARDING_FAMILIES:
            evergreen.setdefault(candidate.family, candidate)
    signals.sort(key=lambda c: (-c.score, _role_rank(c.family, role), _family_index(c.family), c.key))

    out: list[StarterCandidate] = []
    families: set[str] = set()
    named: set[tuple[str, str]] = set()
    for candidate in signals:
        if len(out) >= MAX_SIGNALS:
            break
        if candidate.family in families:
            continue
        chosen: StarterCandidate | None = candidate
        while chosen is not None and chosen.ref_id is not None and chosen.ref_id in named:
            chosen = chosen.fallback
        if chosen is None:
            continue
        if chosen is not candidate:
            chosen.score = candidate.score
        families.add(candidate.family)
        if chosen.ref_id is not None:
            named.add(chosen.ref_id)
        out.append(chosen)
    for family in evergreen_order(role, fresh_install=fresh_install):
        if len(out) >= MAX_STARTERS:
            break
        candidate = evergreen.get(family)
        if candidate is not None and family not in families:
            families.add(family)
            out.append(candidate)
    return out


# --------------------------------------------------------------------------- #
# The per-user starter state (§3.2.3, §3.6). The store persists ``to_doc()`` as one
# canonical-JSON field; these transitions are pure.
# --------------------------------------------------------------------------- #
STATE_SCHEMA = 1
STATE_MAX_KEYS = 64
STATE_MAX_DISMISSED = 32
STATE_MAX_BYTES = 8 * 1024


def _iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _parse(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=timezone.utc)


@dataclass
class StarterKeyStats:
    """One entry of the least-recently-viewed key list."""

    key: str
    family: str
    views: int = 0
    last_view_at: datetime | None = None
    used_at: datetime | None = None


@dataclass
class StarterUserState:
    """The caller's starter state document, schema 1 (§3.2.3). Holds family ids,
    opaque keys, counters and timestamps only: never question text or values (D10).
    ``rev`` is the store revision (the cache key's ``state_rev``), not persisted."""

    last_seen_at: datetime | None = None
    visit_started_at: datetime | None = None
    catchup_since: datetime | None = None
    shift_started_at: datetime | None = None
    keys: list[StarterKeyStats] = field(default_factory=list)
    dismissed: dict[str, datetime] = field(default_factory=dict)
    rev: str | None = None

    @classmethod
    def from_doc(cls, doc: Any, *, rev: str | None = None) -> StarterUserState:
        """Lenient load: anything malformed is dropped, never raised."""
        if not isinstance(doc, Mapping) or doc.get("schema") != STATE_SCHEMA:
            return cls(rev=rev)
        keys: list[StarterKeyStats] = []
        for item in doc.get("keys") or ():
            if not isinstance(item, Mapping):
                continue
            key, family = item.get("key"), item.get("family")
            views = item.get("views")
            if not (isinstance(key, str) and len(key) == 16 and isinstance(family, str) and family):
                continue
            keys.append(StarterKeyStats(
                key=key, family=family[:40],
                views=views if isinstance(views, int) and not isinstance(views, bool) and views >= 0 else 0,
                last_view_at=_parse(item.get("last_view_at")), used_at=_parse(item.get("used_at")),
            ))
        dismissed: dict[str, datetime] = {}
        raw_dismissed = doc.get("dismissed")
        if isinstance(raw_dismissed, Mapping):
            for family, until in raw_dismissed.items():
                parsed = _parse(until)
                if isinstance(family, str) and family and parsed is not None:
                    dismissed[family[:40]] = parsed
        return cls(
            last_seen_at=_parse(doc.get("last_seen_at")),
            visit_started_at=_parse(doc.get("visit_started_at")),
            catchup_since=_parse(doc.get("catchup_since")),
            shift_started_at=_parse(doc.get("shift_started_at")),
            keys=keys[-STATE_MAX_KEYS:], dismissed=dismissed, rev=rev,
        )

    def to_doc(self) -> dict[str, Any]:
        """The schema 1 document (``json.dumps(..., sort_keys=True, separators=(",", ":"))``
        is the store's canonical form)."""
        return {
            "schema": STATE_SCHEMA,
            "last_seen_at": _iso(self.last_seen_at),
            "visit_started_at": _iso(self.visit_started_at),
            "catchup_since": _iso(self.catchup_since),
            "shift_started_at": _iso(self.shift_started_at),
            "keys": [
                {"key": s.key, "family": s.family, "views": s.views,
                 "last_view_at": _iso(s.last_view_at), "used_at": _iso(s.used_at)}
                for s in self.keys
            ],
            "dismissed": {family: _iso(until) for family, until in self.dismissed.items()},
        }

    def key_stats(self, key: str) -> StarterKeyStats | None:
        return next((s for s in self.keys if s.key == key), None)

    def dismissed_families(self, now: datetime) -> frozenset[str]:
        """Families hidden at ``now`` (dismissed until a time after it)."""
        return frozenset(f for f, until in self.dismissed.items() if until > now)


@dataclass(frozen=True)
class VisitView:
    """How a read at ``now`` sees the visit (§3.6, "A GET at time t never writes")."""

    baseline: datetime | None        # the catch-up baseline
    visit_started_at: datetime | None
    shift_started_at: datetime | None
    new_visit: bool                  # the gap since last_seen_at is at least VISIT_GAP
    new_shift: bool                  # ... at least SHIFT_GAP (a shift starts now)
    last_seen_at: datetime | None


def visit_view(state: StarterUserState | None, now: datetime) -> VisitView:
    """The state as of a visit starting now when the gap is at least
    :data:`VISIT_GAP` (baseline = ``last_seen_at``; a shift starts now when the gap is
    at least :data:`SHIFT_GAP`), otherwise as stored (baseline = ``catchup_since``)."""
    state = state or StarterUserState()
    last = state.last_seen_at
    gap = (now - last) if last is not None else None
    if gap is None or gap >= VISIT_GAP:
        new_shift = gap is None or gap >= SHIFT_GAP
        return VisitView(
            baseline=last, visit_started_at=now,
            shift_started_at=now if new_shift else state.shift_started_at,
            new_visit=True, new_shift=new_shift, last_seen_at=last,
        )
    return VisitView(
        baseline=state.catchup_since, visit_started_at=state.visit_started_at,
        shift_started_at=state.shift_started_at, new_visit=False, new_shift=False, last_seen_at=last,
    )


def _prune(state: StarterUserState, now: datetime) -> None:
    state.dismissed = {f: u for f, u in state.dismissed.items() if u > now}
    if len(state.dismissed) > STATE_MAX_DISMISSED:
        newest = sorted(state.dismissed.items(), key=lambda item: item[1], reverse=True)
        state.dismissed = dict(newest[:STATE_MAX_DISMISSED])
    epoch = datetime.min.replace(tzinfo=timezone.utc)
    state.keys.sort(key=lambda s: s.last_view_at or epoch)
    del state.keys[:-STATE_MAX_KEYS]


def record_viewed(
    state: StarterUserState, now: datetime, keys: Mapping[str, str] | Sequence[tuple[str, str]] = (),
) -> StarterUserState:
    """Apply a ``viewed`` event at ``now`` (§3.6). ``keys`` maps each shown key to its
    family (the server resolves families from the starters it served; a key it did not
    serve is ignored by the caller). Returns a new state."""
    out = replace(state, keys=[replace(s) for s in state.keys], dismissed=dict(state.dismissed))
    last = out.last_seen_at
    gap = (now - last) if last is not None else None
    if gap is None or gap >= VISIT_GAP:
        out.catchup_since = last
        out.visit_started_at = now
    if gap is None or gap >= SHIFT_GAP:
        out.shift_started_at = now
    out.last_seen_at = now
    pairs = keys.items() if isinstance(keys, Mapping) else keys
    for key, family in pairs:
        stats = out.key_stats(key)
        if stats is None:
            stats = StarterKeyStats(key=key, family=family)
            out.keys.append(stats)
        stats.views += 1
        stats.last_view_at = now
    _prune(out, now)
    return out


def record_used(
    state: StarterUserState, now: datetime,
    keys: Mapping[str, str] | Iterable[str | tuple[str, str]],
) -> StarterUserState:
    """Apply a ``used`` event: ``used_at = now`` for each key (§3.5 novelty).

    ``keys`` maps each used key to its family (a mapping or ``(key, family)`` pairs,
    the shape :func:`record_viewed` takes). A key with no entry yet gets one (no view,
    used now), so a use that reaches the server before its ``viewed`` event (the first
    send, a catch-up clause) is never lost and later views never demote the card as
    unused. A bare key (no family) updates an existing entry only. Returns a new state."""
    out = replace(state, keys=[replace(s) for s in state.keys], dismissed=dict(state.dismissed))
    pairs = keys.items() if isinstance(keys, Mapping) else keys
    for item in pairs:
        key, family = (item, None) if isinstance(item, str) else item
        stats = out.key_stats(key)
        if stats is None:
            if not family:
                continue
            stats = StarterKeyStats(key=key, family=family, views=0, last_view_at=now)
            out.keys.append(stats)
        stats.used_at = now
    _prune(out, now)
    return out


def record_dismissed(state: StarterUserState, now: datetime, families: Iterable[str]) -> StarterUserState:
    """Apply a ``dismissed`` event: each family is hidden until ``now + DISMISS_FOR``."""
    out = replace(state, keys=[replace(s) for s in state.keys], dismissed=dict(state.dismissed))
    for family in families:
        out.dismissed[family] = now + DISMISS_FOR
    _prune(out, now)
    return out


def state_size(state: StarterUserState) -> int:
    """Bytes of the canonical document (the store keeps it within :data:`STATE_MAX_BYTES`)."""
    return len(json.dumps(state.to_doc(), sort_keys=True, separators=(",", ":")).encode("utf-8"))


# --------------------------------------------------------------------------- #
# Starters from templates.
# --------------------------------------------------------------------------- #
def starter_from_template(
    template_id: str, slots: Mapping[str, Any] | None = None, *, reason: str | None = None,
    reason_variant: str = "default", reason_slots: Mapping[str, Any] | None = None,
    ref: ChatStarterRef | None = None, urgency: StarterUrgency = "none",
    as_of: str | None = None, expires_at: str | None = None,
) -> ChatStarter:
    """A :class:`ChatStarter` worded by ``chat_starter_text``.

    ``id`` is the template's family, ``label`` its short name, ``tools`` its tools,
    ``description`` equals ``reason`` (older clients) and ``key`` is
    :func:`starter_key`. ``reason`` defaults to ``render_reason(template_id,
    reason_variant, reason_slots)`` ("" when that variant needs slots it was not given
    or does not fit). A ``send`` template with a reference slot builds its ``ref`` from
    that slot; one without carries no ``ref``. A display-only template needs ``ref``:
    ``conversation`` for ``open_conversation``, ``prompt`` for ``use_prompt``. Raises
    ``ValueError`` when the template refuses the slots or the reference does not fit."""
    spec = text.template(template_id)
    prompt = text.render_question(template_id, slots)
    ref_slot = spec.ref_slot
    if ref_slot is not None:
        value = (slots or {}).get(ref_slot)
        if ref is None:
            ref = ChatStarterRef(kind=ref_slot, value=value)
        elif ref.kind != ref_slot or ref.value != value:
            raise ValueError("the reference does not match the question")
    elif spec.action == "open_conversation":
        if ref is None or ref.kind != "conversation":
            raise ValueError("an open_conversation card names its conversation")
    elif spec.action == "use_prompt":
        if ref is None or ref.kind != "prompt":
            raise ValueError("a use_prompt card names its saved prompt")
    elif ref is not None:
        raise ValueError("this question names no reference")
    if reason is None:
        reason = ""
        if reason_variant in spec.reasons:
            try:
                reason = text.render_reason(template_id, reason_variant, reason_slots) or ""
            except ValueError:
                reason = ""
    return ChatStarter(
        id=spec.family, label=spec.label, description=reason, prompt=prompt,
        tools=list(spec.tools), template=template_id, reason=reason, action=spec.action,
        ref=ref, key=starter_key(spec.family, ref), urgency=urgency,
        as_of=as_of, expires_at=expires_at,
    )


def evergreen_starters(*, demo: bool) -> list[ChatStarter]:
    """The static evergreen set (pure, no I/O): ``triage``, ``posture``, ``report``,
    ``explain_metric`` and ``learn_app`` with their §3.4 wording and reason lines, plus
    the ``demo`` card first when Demo Mode is on. Served by ``GET /api/chat/context``
    (compatibility, SPEC D2) and as the ``GET /api/chat/starters`` fallback. Ids are
    family ids; the client still shows a card only when every tool is allowed."""
    families = (("demo",) if demo else ()) + EVERGREEN_ORDER
    return [starter_from_template(family) for family in families]


def case_chip_templates(
    *, status: str | None, verdict: str | None, has_entity: bool, has_related: bool,
    allowed: Callable[[str], bool] | None = None,
) -> list[str]:
    """The three Case Manager chips for a case (§3.14): the first that applies of
    ``case_needs_person`` (status needs_human or escalated), ``case_undecided`` (open,
    no verdict) and ``case_closed_why`` (closed or resolved); then ``case_entity`` when
    the case has a main entity; then ``case_related`` when it shares a campaign or
    entity with another case, else ``case_handoff``; filled to 3 from the remaining
    applicable templates in table order.

    ``allowed`` (optional, additive) is the caller's tool check per template: a chip
    whose answer the caller could not get does not apply, so the pick and the fill run
    over the chips the caller can use (never fewer chips than the grants allow)."""
    value = (status or "").strip().lower()
    applicable = {
        "case_needs_person": value in ("needs_human", "escalated"),
        "case_undecided": value in OPEN_CASE_STATUSES and not verdict,
        "case_closed_why": value in TERMINAL_CASE_STATUSES,
        "case_entity": bool(has_entity),
        "case_related": bool(has_related),
        "case_handoff": True,
    }
    if allowed is not None:
        applicable = {t: ok and bool(allowed(t)) for t, ok in applicable.items()}
    picked: list[str] = []
    first = next((t for t in ("case_needs_person", "case_undecided", "case_closed_why") if applicable[t]), None)
    if first is not None:
        picked.append(first)
    if applicable["case_entity"]:
        picked.append("case_entity")
    if applicable["case_related"]:
        picked.append("case_related")
    elif applicable["case_handoff"]:
        picked.append("case_handoff")
    for template_id in text.CASE_CHIP_TEMPLATES:
        if len(picked) >= 3:
            break
        if applicable[template_id] and template_id not in picked:
            picked.append(template_id)
    return picked[:3]


# --------------------------------------------------------------------------- #
# The builder (§3.2.2, §3.3, §3.6, §3.13, §3.14).
# --------------------------------------------------------------------------- #
#: Rows per page of the bounded open-case read; a page this large or larger has its
#: ``Case`` validation run in a worker thread (the event loop also serves chat streams).
POPULATION_PAGE = 500
POPULATION_OFFLOAD_AT = 200
#: The stored case fields the families read (a transfer hint; whole documents are fine).
POPULATION_FIELDS: tuple[str, ...] = (
    "case_id", "case_number", "cluster_signature", "source_surface", "entity", "status",
    "verdict", "assignee", "risk_score", "created_at", "updated_at", "detected_at",
    "priority_level", "severity_band", "trigger_reason", "source_id", "status_history",
)
#: A campaign is checked for growth only up to this many member cases (one batch read).
CAMPAIGN_MEMBER_READ_LIMIT = 200
#: Conversations the ``continue`` family looks at (the history rail's first page).
CONTINUE_SCAN = 30
#: One volume window: "the last 24 hours" and each of the seven before it (§3.3).
VOLUME_WINDOW = timedelta(hours=24)
#: The families the catch-up line reads, in clause order (§3.6).
CATCHUP_FAMILIES: tuple[str, ...] = ("new_cases", "my_cases", "silent_source", "campaign")
#: Statuses whose ``auto_close_health`` reading makes the ``platform`` card.
PLATFORM_DEGRADED: frozenset[str] = frozenset({"degraded", "collapsed"})


def _utc(now: datetime | None) -> datetime:
    value = now or datetime.now(timezone.utc)
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


def text_iso(value: datetime) -> str:
    """ISO 8601 UTC with a ``Z`` suffix (the wire form of every starter timestamp)."""
    return _iso(value) or ""


def _round_half_up(value: Any) -> int:
    """The integer the Overview gauge shows (round half away from zero, §3.7)."""
    try:
        return int(Decimal(str(float(value))).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
    except (ArithmeticError, TypeError, ValueError):
        return 0


def _ts(value: Any) -> datetime | None:
    """An aware UTC datetime from a stored timestamp (ISO, epoch, datetime), or None."""
    if isinstance(value, datetime):
        return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)
    from ..utils import parse_es_timestamp

    try:
        parsed = parse_es_timestamp(value)
    except Exception:  # noqa: BLE001 -- an unreadable time is "unknown", never an error
        return None
    if parsed is None:
        return None
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=timezone.utc)


def _enum(value: Any) -> str:
    return str(getattr(value, "value", value) or "")


def _same_user(value: Any, caller: str) -> bool:
    """``assignee`` equals the caller, normalised like the case filters (trim, case)."""
    return bool(caller) and str(value or "").strip().lower() == caller.strip().lower()


def _case_age_from(case: Any) -> datetime | None:
    return _ts(getattr(case, "detected_at", None)) or _ts(getattr(case, "created_at", None))


def _entered(case: Any, statuses: Iterable[str]) -> datetime | None:
    """When the case last entered one of ``statuses`` (its status history), else when
    it was detected or created."""
    wanted = set(statuses)
    for entry in reversed(list(getattr(case, "status_history", None) or [])):
        if _enum(getattr(entry, "to_status", None)) in wanted:
            at = _ts(getattr(entry, "at", None))
            if at is not None:
                return at
    return _case_age_from(case)


@dataclass
class _Population:
    """The one bounded open-case read of a build (§3.3 "Open-case population"):
    open cases, newest first, at most :data:`OPEN_POPULATION_LIMIT`. ``complete``: every
    open case is in ``cases`` (so a count over it is exact); ``ok``: the store answered."""

    cases: list[Any] = field(default_factory=list)
    complete: bool = False
    ok: bool = False
    bad: int = 0  # stored documents that did not validate (never counted)

    @property
    def over_limit(self) -> bool:
        return self.ok and not self.complete


def _validate_rows(rows: Sequence[Any]) -> tuple[list[Any], int]:
    from ..models import Case

    kept: list[Any] = []
    bad = 0
    for row in rows:
        if isinstance(row, Case):
            kept.append(row)
            continue
        try:
            kept.append(Case.model_validate(row))
        except Exception:  # noqa: BLE001 -- one unreadable document never hides the rest
            bad += 1
    return kept, bad


async def _read_newest(
    store: Any, *, limit: int, statuses: Iterable[str] | None, fields: tuple[str, ...] | None,
    pause: Callable[[], Awaitable[None]] | None = None, page_size: int = 0,
) -> tuple[_Population, bool]:
    """Cases newest first (``statuses`` only, when given), at most ``limit``, read page
    by page with each large page validated in a worker thread (the event loop also
    serves chat streams); ``pause`` (optional) is awaited after every page. Returns the
    population and whether the store honoured the newest-first order. Raises the
    store's error when even the first page fails."""
    from .case_aggregate import scan_cases

    kept: list[Any] = []
    state = {"over": False, "bad": 0}
    wanted = frozenset(statuses) if statuses is not None else None

    async def consume(page: list[Any]) -> None:
        rows = [
            r for r in page
            if wanted is None
            or _enum(r.get("status") if isinstance(r, dict) else getattr(r, "status", None)) in wanted
        ]
        if len(rows) >= POPULATION_OFFLOAD_AT:
            cases, bad = await asyncio.to_thread(_validate_rows, rows)
        else:
            cases, bad = _validate_rows(rows)
        state["bad"] += bad
        kept.extend(cases)
        if len(kept) > limit:
            state["over"] = True
        if pause is not None:
            await pause()

    outcome = await scan_cases(
        store, consume, page_size=page_size or POPULATION_PAGE, raw=True, statuses=statuses,
        newest_first=True, fields=fields, stop=lambda: bool(state["over"]),
    )
    epoch = datetime.min.replace(tzinfo=timezone.utc)
    kept.sort(key=lambda c: (_ts(getattr(c, "created_at", None)) or epoch, str(c.case_id)), reverse=True)
    over = bool(state["over"]) or len(kept) > limit
    complete = bool(outcome.complete and not outcome.stopped and not over and not state["bad"])
    return _Population(cases=kept[:limit], complete=complete, ok=True, bad=int(state["bad"])), \
        bool(outcome.newest_first)


async def read_open_population(store: Any, *, limit: int | None = None) -> _Population:
    """Open cases newest first, at most ``limit`` (default :data:`OPEN_POPULATION_LIMIT`;
    one bounded read shared by every family of a build). Raises the store's error when
    even the first page fails."""
    limit = OPEN_POPULATION_LIMIT if limit is None else int(limit)
    population, _ordered = await _read_newest(store, limit=limit, statuses=OPEN_CASE_STATUSES,
                                              fields=POPULATION_FIELDS)
    return population


#: Families whose reading is too costly for every build (a 5,000-case page, a 7-day
#: fold over whole documents). A per-AppState refresher keeps their reading current in
#: the background while starters are being read: a build that wants a reading starts a
#: refresh AFTER its response when the reading is older than :data:`SLOW_REFRESH_S`, and
#: each refresh schedules the next one :data:`SLOW_REFRESH_S` after its own start until
#: no build has asked for :data:`SLOW_IDLE_S`. A refresh reads the store page by page,
#: runs every per-row computation in a worker thread and, between pages, gives way to
#: any build in progress (:meth:`SlowSignals.give_way`), so it never competes with a
#: reply for longer than one page. A build uses a reading only while it is younger than
#: :data:`SLOW_MAX_AGE_S` (the response cache's own bound, :data:`CACHE_TTL_S`; age
#: counted from the instant the reading describes), and a card built from one carries
#: that instant as its ``as_of``: its count is the exact count as of then, never
#: presented as newer. Until a reading exists (the first read after a start or a long
#: idle) the family produces nothing.
SLOW_FAMILIES: tuple[str, ...] = ("hunt", "platform")
SLOW_REFRESH_S = 40.0
SLOW_MAX_AGE_S = float(CACHE_TTL_S)
SLOW_IDLE_S = 600.0
#: A refresh slower than this is abandoned (no reading). With SLOW_REFRESH_S it keeps
#: every reading in use under SLOW_MAX_AGE_S.
SLOW_COMPUTE_TIMEOUT_S = 20.0
#: How long a refresh waits between two pages while builds are in progress, at most.
GIVE_WAY_MAX_S = 0.5
GIVE_WAY_POLL_S = 0.01
#: Rows per page of a background reading (small pages: short turns on the event loop).
SLOW_PAGE = 250
MAX_SLOW_ENTRIES = 64
#: The memo clock (tests replace it).
_slow_clock = time.monotonic

#: ``compute(now, give_way)``: the reading as of ``now``; ``give_way`` is awaited
#: between pages of a store read.
SlowCompute = Callable[[datetime, Callable[[], Awaitable[None]]], Awaitable[Any]]


@dataclass
class _SlowEntry:
    value: Any
    at: float              # the memo clock when the reading started (the instant it describes)
    measured_at: datetime  # that instant as a time (the reading's window ends there)


class SlowSignals:
    """The per-AppState memo of the slow families (org-level aggregates only: never a
    caller's own data, never a value a grant would hide; eligibility is still checked
    per caller on every build). It holds the readings, the latest way to compute each
    (the store, the policy and the zone of the newest build that asked; never a
    request or a tool context), the refresh in flight or scheduled per key and how many
    builds are in progress (a refresh gives way to them)."""

    def __init__(self) -> None:
        self.entries: dict[tuple[Any, ...], _SlowEntry] = {}
        self.computes: dict[tuple[Any, ...], tuple[SlowCompute, datetime, float]] = {}
        self.used: dict[tuple[Any, ...], float] = {}
        self.running: dict[tuple[Any, ...], asyncio.Task[None]] = {}
        self.timers: dict[tuple[Any, ...], asyncio.TimerHandle] = {}
        self.active_builds = 0
        self._one_at_a_time: asyncio.Lock | None = None  # one refresh reads at a time

    def read(self, key: tuple[Any, ...]) -> _SlowEntry | None:
        """The reading of ``key`` when it is young enough to show, else None."""
        entry = self.entries.get(key)
        if entry is None or _slow_clock() - entry.at >= SLOW_MAX_AGE_S:
            return None
        return entry

    async def give_way(self) -> None:
        """Between two pages of a refresh: wait while a build is in progress (at most
        :data:`GIVE_WAY_MAX_S`), so a background reading never slows a reply for more
        than the page it is on."""
        waited = 0.0
        while self.active_builds > 0 and waited < GIVE_WAY_MAX_S:
            await asyncio.sleep(GIVE_WAY_POLL_S)
            waited += GIVE_WAY_POLL_S

    def want(self, key: tuple[Any, ...], compute: SlowCompute, now: datetime) -> None:
        """A build at ``now`` read ``key``: remember how to compute it, and refresh it
        now when it is missing or due and no refresh is in flight (else make sure the
        next one is scheduled)."""
        clock = _slow_clock()
        self.used[key] = clock
        self.computes[key] = (compute, now, clock)
        if key in self.running:
            return
        entry = self.entries.get(key)
        due = SLOW_REFRESH_S - (clock - entry.at) if entry is not None else 0.0
        if due <= 0:
            self._start(key)
        elif key not in self.timers:
            self._schedule(key, asyncio.get_running_loop(), due)

    def _start(self, key: tuple[Any, ...]) -> None:
        timer = self.timers.pop(key, None)
        if timer is not None:
            timer.cancel()
        task = asyncio.get_running_loop().create_task(self._refresh(key))
        self.running[key] = task
        task.add_done_callback(lambda done, key=key: self._finished(key, done))

    def _schedule(self, key: tuple[Any, ...], loop: asyncio.AbstractEventLoop, delay: float) -> None:
        if loop.is_closed():
            return
        timer = self.timers.pop(key, None)
        if timer is not None:
            timer.cancel()
        self.timers[key] = loop.call_later(max(0.0, delay), self._tick, key)

    def _tick(self, key: tuple[Any, ...]) -> None:
        self.timers.pop(key, None)
        if key in self.running:
            return
        if _slow_clock() - self.used.get(key, float("-inf")) >= SLOW_IDLE_S:
            self.computes.pop(key, None)  # idle: forget how to compute it
            return
        self._start(key)

    def _finished(self, key: tuple[Any, ...], task: asyncio.Task[None]) -> None:
        if self.running.get(key) is task:
            del self.running[key]
        if task.cancelled():
            return
        task.exception()  # retrieved (``_refresh`` never raises but a cancel)
        clock = _slow_clock()
        if clock - self.used.get(key, float("-inf")) < SLOW_IDLE_S:
            entry = self.entries.get(key)
            started = entry.at if entry is not None else clock
            self._schedule(key, task.get_loop(), SLOW_REFRESH_S - (clock - started))
        else:  # idle: forget how to compute it (nothing keeps the store alive)
            self.computes.pop(key, None)

    async def _refresh(self, key: tuple[Any, ...]) -> None:
        if self._one_at_a_time is None:
            self._one_at_a_time = asyncio.Lock()
        async with self._one_at_a_time:
            await self._refresh_now(key)

    async def _refresh_now(self, key: tuple[Any, ...]) -> None:
        compute, build_now, build_clock = self.computes[key]
        started = _slow_clock()
        # The build's clock carried forward (the wall clock in production; a test's
        # fixed instant in tests), so the reading describes "now" for the next build.
        now = build_now + timedelta(seconds=max(0.0, started - build_clock))
        try:
            value = await asyncio.wait_for(compute(now, self.give_way), SLOW_COMPUTE_TIMEOUT_S)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 -- no reading: the family stays quiet
            _warn_once(str(key[0]), exc)
            value = None
        self.entries[key] = _SlowEntry(value, started, now)
        while len(self.entries) > MAX_SLOW_ENTRIES:
            self.entries.pop(next(iter(self.entries)))

    async def settle(self) -> None:
        """Wait for every refresh in flight (tests). A scheduled one stays scheduled;
        :meth:`aclose` cancels it."""
        for _ in range(1000):
            tasks = [t for t in self.running.values() if not t.done()]
            if not tasks:
                break
            await asyncio.gather(*tasks, return_exceptions=True)
        await asyncio.sleep(0)

    async def aclose(self, timeout: float = 2.0) -> None:
        """Shutdown: cancel every scheduled refresh, let a refresh in flight finish (its
        worker thread cannot be interrupted) for up to ``timeout`` seconds, then cancel
        what is left."""
        for timer in self.timers.values():
            timer.cancel()
        self.timers.clear()
        self.used.clear()  # nothing schedules a next refresh from here on
        tasks = [t for t in self.running.values() if not t.done()]
        if tasks:
            _done, pending = await asyncio.wait(tasks, timeout=timeout)
            for task in pending:
                task.cancel()
            if pending:
                await asyncio.gather(*pending, return_exceptions=True)
        self.computes.clear()


_SLOW_SIGNALS: "weakref.WeakKeyDictionary[Any, SlowSignals]" = weakref.WeakKeyDictionary()


def slow_signals(state: Any) -> SlowSignals:
    """THE slow-family memo of ``state``."""
    memo = _SLOW_SIGNALS.get(state)
    if memo is None:
        memo = _SLOW_SIGNALS[state] = SlowSignals()
    return memo


async def settle_slow_signals(state: Any) -> None:
    """Wait until the slow families' refreshes of ``state`` in flight have finished."""
    await slow_signals(state).settle()


async def close_slow_signals(state: Any) -> None:
    """Stop the slow families' background refreshes of ``state`` (``AppState.shutdown``)."""
    memo = _SLOW_SIGNALS.get(state)
    if memo is not None:
        await memo.aclose()


@dataclass
class _Built:
    """One family's output: its card (or None) and, for the catch-up line, its clause
    text (a non-zero count since the baseline, or None)."""

    candidate: StarterCandidate | None = None
    clause: str | None = None


class _Build:
    """Everything one build reads, resolved once and shared by the families (the same
    ``ChatToolContext`` the chat turn builds for this caller, §3.2.4)."""

    def __init__(self, *, state: Any, request: Any, ctx: Any, now: datetime, surface: str,
                 user_state: StarterUserState, infos: Mapping[str, Any], username: str,
                 role: str, auth_on: bool, object_scoped: bool, conversation_id: str | None) -> None:
        from .time_windows import zone_for

        self.state = state
        self.request = request
        self.ctx = ctx
        self.now = now
        self.surface = surface
        self.user_state = user_state
        self.infos = infos
        self.username = username
        self.role = role
        self.auth_on = auth_on
        self.object_scoped = object_scoped
        self.conversation_id = conversation_id
        self.prefs = ctx.prefs
        self.demo = bool(getattr(ctx, "demo_active", False))
        self.zone, self.tz_name = zone_for(getattr(getattr(self.prefs, "sla", None), "timezone", None))
        self.view = visit_view(user_state, now)
        self.baseline: datetime | None = self.view.baseline
        if self.baseline is None and self.demo and surface == "home":
            # §3.6 Demo: no baseline yet, so the seed's shift anchor stands in (the seed
            # exposes none, so the visit's start minus 8 hours: stable within a visit).
            self.baseline = (self.view.visit_started_at or now) - DEMO_BASELINE_AGE
        self.as_of = text_iso(now)
        self.expires_at = text_iso(now + timedelta(seconds=EXPIRES_AFTER_S))
        self._population: asyncio.Task[_Population] | None = None
        self._scan_cutoff: asyncio.Task[datetime | None] | None = None
        #: Slow-family readings this build asked for (refreshed once the response is built).
        self.deferred: list[tuple[tuple[Any, ...], SlowCompute]] = []
        #: The loop time by which every family must have answered (set by the builder).
        self.deadline: float | None = None
        #: A family raised or timed out, or a shared read failed: the answer is complete
        #: as far as it goes, but the route does not cache it (a transient overrun is
        #: never pinned for :data:`CACHE_TTL_S`).
        self.degraded = False

    def slow(self, name: str, compute: SlowCompute) -> _SlowEntry | None:
        """The reading of slow family ``name`` (see :data:`SLOW_FAMILIES`) when one is
        young enough to show, else None. Either way the refresher is told this build
        wants it (after the response)."""
        key = (name, self.demo, id(self.ctx.cases), self.tz_name)
        self.deferred.append((key, compute))
        return slow_signals(self.state).read(key)

    def start_deferred(self) -> None:
        memo = slow_signals(self.state)
        for key, compute in self.deferred:
            try:
                memo.want(key, compute, self.now)
            except RuntimeError:  # no running loop (never in a route)
                pass
        self.deferred.clear()

    def remaining(self) -> float:
        """Seconds left for family work before the build must be assembled."""
        if self.deadline is None:
            return BUILD_TIMEOUT_S
        return max(0.0, self.deadline - asyncio.get_running_loop().time())

    # ---- shared reads (one task each, shielded from a waiter's timeout) ---------- #
    async def population(self) -> _Population:
        if self._population is None:
            self._population = asyncio.ensure_future(read_open_population(self.ctx.cases))
        return await asyncio.shield(self._population)

    def prefetch_cutoff(self) -> None:
        """Start the case-number cutoff read alongside the population read."""
        if self._scan_cutoff is None:
            self._scan_cutoff = asyncio.ensure_future(self._cutoff())

    async def _cutoff(self) -> datetime | None:
        """The creation time of the oldest case the chat case tools resolve a case
        NUMBER in (their newest-``CASE_SCAN_LIMIT`` page), or None when every case is in
        it (``get_case`` then finds any case number)."""
        from ..agents.chat_tools.cases import CASE_SCAN_LIMIT

        cases, total = await self.ctx.cases.list(limit=1, offset=CASE_SCAN_LIMIT - 1)
        if int(total or 0) <= CASE_SCAN_LIMIT or not cases:
            return None
        return _ts(getattr(cases[0], "created_at", None)) or self.now

    async def case_value(self, case: Any) -> str | None:
        """The case reference a card names: its display number when ``get_case`` can
        resolve that number, else its id; ``None`` when neither passes the grammar."""
        number = getattr(case, "case_number", "") or ""
        case_id = getattr(case, "case_id", "") or ""
        if number and text.ref_value("case", number) == number:
            if self._scan_cutoff is None:
                self._scan_cutoff = asyncio.ensure_future(self._cutoff())
            try:
                cutoff = await asyncio.shield(self._scan_cutoff)
            except Exception:  # noqa: BLE001 -- unknown: the id always resolves
                cutoff = self.now
            created = _ts(getattr(case, "created_at", None))
            if cutoff is None or (created is not None and created > cutoff):
                return number
        return case_id if case_id and text.ref_value("case", case_id) == case_id else None

    def close(self) -> None:
        for task in (self._population, self._scan_cutoff):
            if task is None:
                continue
            if not task.done():
                task.cancel()
            elif not task.cancelled():
                task.exception()  # retrieved: a failed shared read is never re-raised at exit

    # ---- grants -------------------------------------------------------------- #
    def tools_ok(self, tools: Iterable[str], kinds: Mapping[str, str] | None = None) -> bool:
        """Every tool allowed for the caller and switched on, and the kind a kind-gated
        tool must allow (the composer's ``catalogue_infos`` check)."""
        for name in tools:
            info = self.infos.get(name)
            if info is None or not info.allowed or not getattr(info, "available", True):
                return False
            kind = (kinds or {}).get(name)
            if kind and kind in (info.kind_requires or {}) and kind not in (info.kinds_allowed or []):
                return False
        return True

    def template_ok(self, template_id: str) -> bool:
        spec = text.template(template_id)
        return self.tools_ok(spec.tools, spec.kinds)

    def eligible(self, family: str) -> bool:
        needs = FAMILY_NEEDS.get(family)
        if needs is None:
            return False
        if needs.kind == "case" and self.object_scoped:
            return False
        if any(pair not in self.ctx.grants for pair in needs.permissions):
            return False
        return self.tools_ok(needs.tools, needs.kinds)

    # ---- wording ------------------------------------------------------------- #
    def card(self, template_id: str, slots: Mapping[str, Any] | None = None, *,
             variant: str = "default", reason_slots: Mapping[str, Any] | None = None,
             urgency: StarterUrgency = "none", reason: str | None = None,
             ref: ChatStarterRef | None = None) -> ChatStarter | None:
        """A stamped card, or None when the template refuses the slots, the reason does
        not fit, or the caller cannot run every tool the card lists (never altered)."""
        if not self.template_ok(template_id):
            return None
        try:
            return starter_from_template(
                template_id, slots, reason=reason, reason_variant=variant, reason_slots=reason_slots,
                ref=ref, urgency=urgency, as_of=self.as_of, expires_at=self.expires_at,
            )
        except ValueError:  # pydantic's ValidationError is a ValueError too
            return None

    def since_label(self, at: datetime) -> str:
        return text.format_since(at, now=self.now, tz=self.zone)

    def age(self, at: datetime | None) -> str | None:
        return text.format_age(self.now - at) if at is not None else None


def _first_reason(build: _Build, template_id: str, options: Sequence[tuple[str, Mapping[str, Any]]]) -> str:
    """The first reason variant that renders within 60 characters ("" when none does)."""
    for variant, slots in options:
        try:
            line = text.render_reason(template_id, variant, slots)
        except ValueError:
            line = None
        if line:
            return line
    return ""


# ---- the signal families (§3.3) ---------------------------------------------- #
async def _family_needs_human(b: _Build) -> _Built:
    from . import shift_report

    pop = await b.population()
    sla = getattr(b.prefs, "sla", None)
    rows = []
    for case in pop.cases:
        status = _enum(case.status)
        flagged = status in ("needs_human", "escalated") or _enum(case.verdict) == "NEEDS_HUMAN"
        if flagged and (not (case.assignee or "").strip() or _same_user(case.assignee, b.username)):
            score_ = shift_report.urgency_score(case, sla=sla, now=b.now, prefs=b.prefs)
            rows.append((-score_, -float(case.risk_score or 0.0), str(case.case_id), case))
    for _s, _r, _id, case in sorted(rows, key=lambda r: r[:3]):
        value = await b.case_value(case)
        if value is None:
            continue
        escalated = _enum(case.status) == "escalated"
        since = _entered(case, ("escalated",) if escalated else (_enum(case.status), "needs_human"))
        # The integer the gauge and the reason line show drives the dot too (§3.5, §3.7):
        # a case at 79.6 reads "risk 80" and is critical.
        risk = _round_half_up(case.risk_score)
        options: list[tuple[str, Mapping[str, Any]]] = []
        if since is not None:
            options.append(("escalated" if escalated else "waiting", {"age": b.age(since) or "", "n": risk}))
        # No readable time: the state and the risk alone (never a blank reason).
        options.append(("escalated_risk" if escalated else "waiting_risk", {"n": risk}))
        reason = _first_reason(b, "needs_human", options)
        multiplier, level = family_urgency("needs_human", risk=float(risk))
        starter = b.card("needs_human", {"case": value}, reason=reason, urgency=level)
        if starter is None:
            continue
        return _Built(StarterCandidate(
            "needs_human", starter, urgency=multiplier, urgency_level=level, signal_at=since,
            assigned_to_caller=_same_user(case.assignee, b.username),
            newer_than_baseline=bool(b.baseline and since and since > b.baseline),
        ))
    return _Built()


async def _assigned_count(b: _Build) -> int | None:
    """The exact number of open cases assigned to the caller (an exact aggregate when
    the population is not the whole open set), else None."""
    from .case_aggregate import CaseAggregateSpec, aggregate_cases
    from .time_windows import resolve_window

    result = await aggregate_cases(b.ctx.cases, CaseAggregateSpec(
        window=resolve_window("all", tz=b.tz_name, now=b.now),
        filters={"status_group": "active", "assignee": b.username}, prefs=b.prefs,
    ))
    return int(result.total) if result.exact and not result.partial else None


async def _family_my_cases(b: _Build) -> _Built:
    from . import shift_report

    if not b.auth_on or not b.username:
        return _Built()
    pop = await b.population()
    mine = [c for c in pop.cases if _same_user(c.assignee, b.username)]
    n = len(mine) if pop.complete else await _assigned_count(b)
    if not n:
        return _Built()
    clause = None
    if pop.complete and b.baseline is not None:
        changed = sum(1 for c in mine if (_ts(c.updated_at) or b.baseline) > b.baseline)
        clause = text.clause_my_cases(changed) if changed else None
    past = 0
    sla = getattr(b.prefs, "sla", None)
    if pop.complete and sla is not None and getattr(sla, "enabled", False):
        past = int(shift_report.sla_aging(mine, sla, now=b.now)["totals"]["breached"])
    multiplier, level = family_urgency("my_cases", past_target=past)
    starter: ChatStarter | None = None
    if n == 1:
        case = mine[0] if mine else None
        value = await b.case_value(case) if case is not None else None
        if value is not None:
            opened = _case_age_from(case)
            options_one: list[tuple[str, Mapping[str, Any]]] = []
            if opened is not None:
                options_one.append(("default", {"age": b.age(opened) or ""}))
            options_one.append(("assigned", {}))
            reason = _first_reason(b, "my_cases_one", options_one)
            starter = b.card("my_cases_one", {"case": value}, reason=reason, urgency=level)
    else:
        options: list[tuple[str, Mapping[str, Any]]] = []
        if past == 1:
            options.append(("past_target_one", {}))
        elif past > 1:
            options.append(("past_target", {"k": past}))
        if pop.complete:
            oldest = min((t for t in (_case_age_from(c) for c in mine) if t is not None), default=None)
            if oldest is not None:
                options.append(("oldest", {"age": b.age(oldest) or ""}))
        # Over the population bound neither figure is known: say why the card is here.
        options.append(("assigned", {}))
        starter = b.card("my_cases", {"n": n}, reason=_first_reason(b, "my_cases", options), urgency=level)
    if starter is None:
        return _Built(clause=None)
    return _Built(StarterCandidate(
        "my_cases", starter, urgency=multiplier, urgency_level=level, assigned_to_caller=True,
    ), clause)


async def _family_sla(b: _Build) -> _Built:
    from . import shift_report

    sla = getattr(b.prefs, "sla", None)
    if sla is None or not getattr(sla, "enabled", False):
        return _Built()
    pop = await b.population()
    if not pop.complete:  # needs the whole open set (§3.3): skipped over the limit
        return _Built()
    aging = shift_report.sla_aging(pop.cases, sla, now=b.now)
    breached, close = aging["breached"], aging["about_to_breach"]
    rows, any_breached = (breached, True) if breached else (close, False)
    if not rows:
        return _Built()
    multiplier, level = family_urgency("sla", any_breached=any_breached)
    assigned = False
    if len(rows) == 1:
        by_id = {c.case_id: c for c in pop.cases}
        case = by_id.get(rows[0].get("case_id"))
        value = await b.case_value(case) if case is not None else None
        if value is None:
            return _Built()
        assigned = _same_user(case.assignee, b.username)
        if any_breached:
            overdue = timedelta(minutes=float(rows[0].get("overdue_minutes") or 0.0))
            reason = _first_reason(b, "sla_breached_one", [("default", {"age": text.format_age(overdue)})])
            starter = b.card("sla_breached_one", {"case": value}, reason=reason, urgency=level)
        else:
            starter = b.card("sla_close_one", {"case": value}, urgency=level)
    elif any_breached:
        worst = max(float(r.get("overdue_minutes") or 0.0) for r in rows)
        reason = _first_reason(b, "sla_breached", [("default", {"age": text.format_age(timedelta(minutes=worst))})])
        starter = b.card("sla_breached", {"n": len(rows)}, reason=reason, urgency=level)
    else:
        starter = b.card("sla_close", {"n": len(rows)}, urgency=level)
    if starter is None:
        return _Built()
    return _Built(StarterCandidate("sla", starter, urgency=multiplier, urgency_level=level,
                                   assigned_to_caller=assigned))


def _window(start: datetime, end: datetime, tz: str, *, label: str = "since the last visit") -> Any:
    """The exact half-open range ``[start, end)`` (never aligned to a calendar unit)."""
    from .time_windows import ResolvedWindow

    return ResolvedWindow(start=start, end=end, label=label, tz=tz,
                          token="starters", now=end, kind="range")


async def _family_new_cases(b: _Build) -> _Built:
    from .case_aggregate import CaseAggregateSpec, aggregate_cases

    if b.baseline is None or b.baseline >= b.now:
        return _Built()
    result = await aggregate_cases(b.ctx.cases, CaseAggregateSpec(
        window=_window(b.baseline, b.now, b.tz_name), group_by=("severity",), prefs=b.prefs,
    ))
    if not result.exact or result.partial:
        return _Built()
    n = int(result.total)
    if n <= 0:
        return _Built()
    critical = sum(int(g["metrics"].get("count") or 0) for g in result.groups
                   if (g.get("key") or {}).get("severity") == "critical")
    latest = _ts(result.latest)
    multiplier, level = family_urgency("new_cases", critical=critical)
    since = b.since_label(b.baseline)
    if n == 1:
        starter = b.card("new_cases_one", {"since": since}, urgency=level)
    else:
        options: list[tuple[str, Mapping[str, Any]]] = []
        if critical >= 1:
            options.append(("critical", {"k": critical}))
        if latest is not None:
            options.append(("newest", {"age": b.age(latest) or ""}))
        starter = b.card("new_cases", {"n": n, "since": since},
                         reason=_first_reason(b, "new_cases", options), urgency=level)
    clause = text.clause_new_cases(n, critical)
    if starter is None:
        return _Built()
    return _Built(StarterCandidate(
        "new_cases", starter, urgency=multiplier, urgency_level=level, signal_at=latest,
        newer_than_baseline=True,
    ), clause)


def volume_change(daily: Sequence[int]) -> tuple[str, int, int] | None:
    """``("spike" | "drop", n, usual)`` from ``VOLUME_BASELINE_DAYS + 1`` exact 24-hour
    totals, oldest first (§3.3): ``n`` is the last (the 24 hours ending now) and
    ``usual`` the median of the seven before it. Spike: ``n >= 2 * usual`` and
    ``n - usual >= 5``. Drop: ``usual >= 10`` and ``n <= 0.5 * usual``. None otherwise
    (or too few windows)."""
    counts = [int(c) for c in daily]
    if len(counts) < VOLUME_BASELINE_DAYS + 1:
        return None
    counts = counts[-(VOLUME_BASELINE_DAYS + 1):]
    n, windows = counts[-1], counts[:-1]
    usual = sorted(windows)[len(windows) // 2]
    if n >= VOLUME_SPIKE_RATIO * usual and n - usual >= VOLUME_SPIKE_MIN_DELTA:
        return "spike", n, usual
    if usual >= VOLUME_DROP_MIN_USUAL and n <= VOLUME_DROP_RATIO * usual:
        return "drop", n, usual
    return None


async def volume_windows(b: _Build) -> list[int] | None:
    """``VOLUME_BASELINE_DAYS + 1`` exact 24-hour case counts, oldest first, or None
    unless every one is exact.

    * The last one is the rolling 24 hours ending now, ``[now - 24h, now)``: exactly
      what "in the last 24 hours" means to ``case_stats`` and to the ``noisy_rule``
      card (one count-only aggregate, pushed down where the store can).
    * The seven before it are whole-hour 24-hour windows ending at ``F``, the start of
      the operator-zone hour that contains ``now - 24h``: ``[F - 24h * i, F - 24h *
      (i - 1))`` for ``i`` 7 to 1, summed in code from ONE hourly aggregate (§3.3). No
      case of the last 24 hours is ever counted in the baseline and no case is counted
      twice; the cases of the under-one-hour gap ``[F, now - 24h)`` are in neither.

    Two aggregates, not one per window: a per-window range count costs about as much as
    the hourly one on the SQL stores and they contend with the shared population read."""
    from .case_aggregate import MISSING_BUCKET, CaseAggregateSpec, aggregate_cases
    from .time_windows import period_start

    start = b.now - VOLUME_WINDOW
    # F: the start of the hour (operator zone) that contains the start of the last 24 hours.
    edge = period_start(start, "hour", b.zone)
    first = edge - VOLUME_WINDOW * VOLUME_BASELINE_DAYS
    last, hourly = await asyncio.gather(
        aggregate_cases(b.ctx.cases, CaseAggregateSpec(
            window=_window(start, b.now, b.tz_name, label="the last 24 hours"))),
        aggregate_cases(b.ctx.cases, CaseAggregateSpec(
            window=_window(first, edge, b.tz_name, label="the seven days before"), bucket="hour")),
    )
    if not (last.exact and hourly.exact) or last.partial or hourly.partial:
        return None
    by_start: dict[datetime, int] = {}
    for group in hourly.groups:
        at = _ts(group.get("bucket_start"))
        if group.get("bucket") == MISSING_BUCKET or at is None:
            continue
        by_start[at] = by_start.get(at, 0) + int(group["metrics"].get("count") or 0)
    if any(at < first for at in by_start):
        return None  # a bucket started before the range (a zone whose hours are not whole)
    daily = [
        sum(n for at, n in by_start.items() if edge - VOLUME_WINDOW * i <= at < edge - VOLUME_WINDOW * (i - 1))
        for i in range(VOLUME_BASELINE_DAYS, 0, -1)
    ]
    return daily + [int(last.total)]


async def _family_volume_change(b: _Build) -> _Built:
    daily = await volume_windows(b)
    signal = volume_change(daily) if daily is not None else None
    if signal is None:
        return _Built()
    kind, n, usual = signal
    if kind == "spike":
        if usual:
            ratio = n / usual
            multiplier, level = family_urgency("volume_change", ratio=ratio)
            reason = _first_reason(b, "volume_spike", [("default", {"x": text.format_ratio(ratio)})])
        else:  # "{x} times" has nothing to multiply: say why the card is here instead
            multiplier, level = family_urgency("volume_change", ratio=2 * VOLUME_SPIKE_RATIO)
            reason = _first_reason(b, "volume_spike", [("from_zero", {})])
        starter = b.card("volume_spike", {"n": n, "m": usual}, reason=reason, urgency=level)
    else:
        multiplier, level = family_urgency("volume_change", drop=True)
        starter = b.card("volume_drop", {"n": n, "m": usual}, urgency=level)
    if starter is None:
        return _Built()
    return _Built(StarterCandidate("volume_change", starter, urgency=multiplier, urgency_level=level))


async def _family_noisy_rule(b: _Build) -> _Built:
    from .case_aggregate import CaseAggregateSpec, aggregate_cases
    from .time_windows import resolve_window

    result = await aggregate_cases(b.ctx.cases, CaseAggregateSpec(
        window=resolve_window("now-24h", tz=b.tz_name, now=b.now), group_by=("rule",),
    ))
    if not result.exact or result.partial:
        return _Built()
    m = int(result.total)
    for group in result.groups:
        rule = (group.get("key") or {}).get("rule")
        n = int(group["metrics"].get("count") or 0)
        if not isinstance(rule, str) or not rule:
            continue
        if n < NOISY_RULE_MIN_CASES or m <= 0 or n / m < NOISY_RULE_MIN_SHARE:
            return _Built()  # groups come largest first: no later rule qualifies
        if text.ref_value("rule", rule) != rule:
            continue  # this id cannot be named; a smaller rule may still qualify
        multiplier, level = family_urgency("noisy_rule")
        reason = _first_reason(b, "noisy_rule", [("default", {"pct": _round_half_up(100 * n / m)})])
        starter = b.card("noisy_rule", {"rule": rule, "n": n, "m": m}, reason=reason, urgency=level)
        if starter is None:
            continue  # the question would not fit: try the next qualifying rule
        return _Built(StarterCandidate("noisy_rule", starter, urgency=multiplier, urgency_level=level))
    return _Built()


async def _member_times(b: _Build, case_ids: Sequence[str]) -> dict[str, datetime | None] | None:
    """Creation times of a campaign's member cases (one batch read), or None when there
    are too many to read or the store failed."""
    if len(case_ids) > CAMPAIGN_MEMBER_READ_LIMIT:
        return None
    pop = await b.population()
    known = {c.case_id: _ts(c.created_at) for c in pop.cases if c.case_id in set(case_ids)}
    missing = [cid for cid in case_ids if cid not in known]
    if missing:
        batch = getattr(b.ctx.cases, "get_many", None)
        found: dict[str, Any] = dict(await batch(missing)) if callable(batch) else {}
        for cid in missing:
            case = found.get(cid)
            if case is None and not callable(batch):
                case = await b.ctx.cases.get(cid)
            known[cid] = _ts(getattr(case, "created_at", None)) if case is not None else None
    return known


async def _family_campaign(b: _Build) -> _Built:
    if b.baseline is None or b.ctx.campaigns is None:
        return _Built()
    campaigns, _total = await b.ctx.campaigns.list()
    picks: list[tuple[int, int, int, str, Any, bool, int]] = []
    new_count = 0
    for campaign in campaigns:
        if _enum(campaign.status) == "resolved" or text.ref_value("campaign", campaign.id) != campaign.id:
            continue
        members = list(campaign.case_ids or [])
        if len(members) < 2:
            continue
        first = _ts(campaign.first_seen) or _ts(campaign.created_at)
        if first is not None and first > b.baseline:
            new_count += 1
            picks.append((1, len(members), len(members), campaign.id, campaign, True, len(members)))
            continue
        last = _ts(campaign.last_seen)
        if last is None or last <= b.baseline:
            continue
        times = await _member_times(b, members)
        if times is None:
            continue
        grown = sum(1 for t in times.values() if t is not None and t > b.baseline)
        if grown >= 1:
            picks.append((0, grown, len(members), campaign.id, campaign, False, grown))
    if not picks:
        return _Built()
    picks.sort(key=lambda p: (-p[0], -p[1], -p[2], p[3]))
    _new, _k, n, campaign_id, campaign, is_new, grown = picks[0]
    since = b.since_label(b.baseline)
    if is_new:
        options: list[tuple[str, Mapping[str, Any]]] = [("new", {"since": since})]
    elif grown == 1:
        options = [("grown_one", {"since": since})]
    else:
        options = [("grown", {"k": grown, "since": since})]
    multiplier, level = family_urgency("campaign", cases=n)
    starter = b.card("campaign", {"n": n, "campaign": campaign_id},
                     reason=_first_reason(b, "campaign", options), urgency=level)
    if starter is None:
        return _Built()
    return _Built(StarterCandidate(
        "campaign", starter, urgency=multiplier, urgency_level=level,
        signal_at=_ts(campaign.last_seen), newer_than_baseline=True,
    ), text.clause_new_campaigns(new_count) if new_count else None)


def _poll_failed(row: Mapping[str, Any]) -> bool:
    """The source's last poll failed (``source_health``: not ok, or an error)."""
    return row.get("last_poll_ok") is False or bool(row.get("last_poll_error"))


def _has_event(row: Mapping[str, Any]) -> bool:
    """The source has a recorded last-event time (any, even one ahead of the clock)."""
    try:
        return int(row.get("last_event_millis") or 0) > 0
    except (TypeError, ValueError):
        return False


def _source_problem(row: Mapping[str, Any]) -> bool:
    """An enabled source the ``source_health`` tool reports as silent or degraded."""
    if not row.get("enabled"):
        return False
    if row.get("silent") or _poll_failed(row):
        return True
    if row.get("healthy") is False:
        return True
    return str(row.get("state") or "").lower() in ("error", "degraded", "failed", "silent")


def _source_reasons(problems: Sequence[Mapping[str, Any]], age: str | None) -> list[tuple[str, Mapping[str, Any]]]:
    """The reason variants of a quiet-source card in order (§3.4, §3.7): how long the
    quietest source has been quiet; else, with no event time to measure from, the
    closed-vocabulary state every flagged source shares (its last poll failed, it has
    received no event yet); else the health check flagged it. Never a blank reason."""
    options: list[tuple[str, Mapping[str, Any]]] = []
    if age:
        options.append(("default", {"age": age}))
    if all(_poll_failed(r) for r in problems):
        options.append(("poll_failed", {}))
    if not any(_has_event(r) for r in problems):
        options.append(("no_events", {}))
    options.append(("flagged", {}))
    return options


async def _family_silent_source(b: _Build) -> _Built:
    reader = getattr(b.ctx, "source_health_rows", None)
    if reader is None:
        return _Built()
    rows = reader()
    if inspect.isawaitable(rows):
        rows = await rows
    now_ms = int(b.now.timestamp() * 1000)
    problems = [r for r in (rows or []) if isinstance(r, dict) and _source_problem(r)]
    if not problems:
        return _Built()

    def quiet(row: Mapping[str, Any]) -> timedelta | None:
        try:
            last = int(row.get("last_event_millis") or 0)
        except (TypeError, ValueError):
            last = 0
        return timedelta(milliseconds=now_ms - last) if 0 < last <= now_ms else None

    longest = max((q for q in (quiet(r) for r in problems) if q is not None), default=None)
    multiplier, level = family_urgency("silent_source", quiet_for=longest)
    if len(problems) == 1:
        row = problems[0]
        value = next((v for v in (row.get("source_name"), row.get("source_id"))
                      if isinstance(v, str) and text.ref_value("source", v) == v), None)
        clause = text.clause_quiet_sources(1)
        if value is None:
            return _Built(clause=clause)
        age = text.format_age(longest) if longest is not None else None
        if age is not None:
            clause = text.clause_quiet_source(value, age) or clause
        reason = _first_reason(b, "silent_source", _source_reasons(problems, age))
        starter = b.card("silent_source", {"source": value}, reason=reason, urgency=level)
    else:
        clause = text.clause_quiet_sources(len(problems))
        age = text.format_age(longest) if longest is not None else None
        reason = _first_reason(b, "silent_sources", _source_reasons(problems, age))
        starter = b.card("silent_sources", {"n": len(problems)}, reason=reason, urgency=level)
    if starter is None:
        return _Built(clause=clause)
    return _Built(StarterCandidate("silent_source", starter, urgency=multiplier, urgency_level=level), clause)


async def _family_budget(b: _Build) -> _Built:
    if b.demo:
        return _Built()
    gate = getattr(b.ctx, "budget_gate", None)
    if gate is None:
        return _Built()
    options: list[tuple[float, str, float, float]] = []  # (pct, template, spent, limit)
    cap = getattr(getattr(b.prefs, "chat_agent", None), "chat_daily_cap_usd", None)
    if isinstance(cap, (int, float)) and not isinstance(cap, bool) and cap > 0 \
            and callable(getattr(gate, "surface_spend_today", None)):
        spent = float(await gate.surface_spend_today("chat"))
        pct = 100.0 * spent / float(cap)
        if pct >= CHAT_CAP_WARN_PCT:
            options.append((pct, "budget_chat", spent, float(cap)))
    status = await gate.status()
    daily = (status or {}).get("daily") or {}
    fraction, limit = daily.get("fraction"), daily.get("cap")
    warn = float((status or {}).get("soft_warn_pct") or 0.8)
    if (status or {}).get("enabled") and isinstance(fraction, (int, float)) and isinstance(limit, (int, float)) \
            and limit > 0 and fraction >= warn:
        options.append((100.0 * float(fraction), "budget_ai", float(daily.get("spent") or 0.0), float(limit)))
    if not options:
        return _Built()
    pct, template_id, spent, limit = max(options, key=lambda o: (o[0], o[1]))
    multiplier, level = family_urgency("budget", pct=pct)
    reason = _first_reason(b, template_id, [("default", {
        "spent": text.format_money(spent), "limit": text.format_money(limit)})])
    starter = b.card(template_id, {"pct": _round_half_up(pct)}, reason=reason, urgency=level)
    if starter is None:
        return _Built()
    return _Built(StarterCandidate("budget", starter, urgency=multiplier, urgency_level=level))


async def _family_shift(b: _Build) -> _Built:
    """Shift start (a shift started within the last hour, or no state yet) or handoff
    (7 to 13 hours into the shift), from the caller's own visit pattern (D4, §3.6)."""
    view = b.view
    shift_at = view.shift_started_at
    if shift_at is not None and timedelta(0) <= b.now - shift_at <= SHIFT_START_WINDOW:
        # When did the caller's previous visit end? Known when this read starts the
        # shift, or when the stored shift began at the current visit.
        known, previous = False, None
        if view.new_shift:
            known, previous = True, view.last_seen_at
        elif view.visit_started_at == shift_at:
            known, previous = True, view.baseline
        gap = (shift_at - previous) if previous is not None else None
        first_ever = known and previous is None
        long_gap = gap is not None and gap > timedelta(hours=SHIFT_BRIEF_HOURS)
        hours = SHIFT_BRIEF_LONG_HOURS if first_ever or long_gap else SHIFT_BRIEF_HOURS
        options: list[tuple[str, Mapping[str, Any]]] = []
        if gap is not None:
            options.append(("gap", {"age": text.format_age(gap)}))
        options.append(("day", {}))
        multiplier, level = family_urgency("shift")
        starter = b.card("shift_start", {"h": hours}, reason=_first_reason(b, "shift_start", options), urgency=level)
    elif shift_at is not None and HANDOFF_FROM <= b.now - shift_at <= HANDOFF_TO:
        on_shift = int((b.now - shift_at).total_seconds() // 3600)
        multiplier, level = family_urgency("shift", handoff=True)
        starter = b.card("shift_handoff", reason=_first_reason(b, "shift_handoff", [("default", {"h": on_shift})]),
                         urgency=level)
    else:
        return _Built()
    if starter is None:
        return _Built()
    return _Built(StarterCandidate("shift", starter, urgency=multiplier, urgency_level=level, signal_at=shift_at))


async def _family_weekly(b: _Build) -> _Built:
    local = b.now.astimezone(b.zone)
    midnight = local.replace(hour=0, minute=0, second=0, microsecond=0)
    baseline = b.view.baseline
    starter: ChatStarter | None = None
    if local.day == 1 and (baseline is None or baseline < midnight):
        year, month = (local.year, local.month - 1) if local.month > 1 else (local.year - 1, 12)
        starter = b.card("monthly", {"month": text.format_month(year, month)})
    if starter is None and local.weekday() == 0 and (baseline is None or baseline < midnight):
        starter = b.card("weekly")
    if starter is None:
        return _Built()
    return _Built(StarterCandidate("weekly", starter))


async def _family_continue(b: _Build) -> _Built:
    store = getattr(b.state, "chat_conversations", None)
    if store is None:
        return _Built()
    summaries, _total = await store.list_for_user(b.username, limit=CONTINUE_SCAN)
    best = None
    for row in summaries:
        updated = _ts(row.updated_at)
        if row.id == b.conversation_id or updated is None or b.now - updated > CONTINUE_WINDOW:
            continue
        if not (row.unread or row.status == "needs_input"):
            continue
        if best is None or updated > best[0]:
            best = (updated, row)
    if best is None:
        return _Built()
    updated, row = best
    if text.ref_value("conversation", row.id) != row.id:
        return _Built()
    needs_input = row.status == "needs_input"
    multiplier, level = family_urgency("continue", needs_input=needs_input)
    starter = b.card("continue", {"title": row.title}, variant="input" if needs_input else "ready",
                     ref=ChatStarterRef(kind="conversation", value=row.id), urgency=level)
    if starter is None:
        return _Built()
    return _Built(StarterCandidate("continue", starter, urgency=multiplier, urgency_level=level,
                                   signal_at=updated))


#: The saved-prompt id prefix of a promptbook (the web ``PROMPTBOOK_ID_PREFIX``) and the
#: line that separates its steps (``promptbookSteps``: a line of three or more hyphens).
PROMPTBOOK_PREFIX = "book-"
_STEP_SEPARATOR = re.compile(r"^\s*-{3,}\s*$")
MAX_PROMPTBOOK_STEPS = 10


def promptbook_steps(body: str) -> int:
    """How many steps a promptbook's text holds (the web ``promptbookSteps``)."""
    steps: list[str] = []
    current: list[str] = []
    for line in str(body or "").splitlines():
        if _STEP_SEPARATOR.match(line):
            steps.append("\n".join(current))
            current = []
        else:
            current.append(line)
    steps.append("\n".join(current))
    return min(MAX_PROMPTBOOK_STEPS, sum(1 for s in steps if s.strip()))


async def _family_saved_prompt(b: _Build) -> _Built:
    store = getattr(b.state, "user_prefs", None)
    if store is None:
        return _Built()
    prefs = await store.get(b.username if b.auth_on and b.username else None)
    favourites = [p for p in (getattr(prefs, "chat_prompts", None) or []) if getattr(p, "favorite", False)]
    # The list keeps the order the prompts were saved in (new ones are appended and an
    # edit keeps its place), so the last favourite is the most recently saved one.
    for prompt in reversed(favourites):
        if text.ref_value("prompt", prompt.id) != prompt.id:
            continue
        ref = ChatStarterRef(kind="prompt", value=prompt.id)
        if prompt.id.startswith(PROMPTBOOK_PREFIX):
            steps = promptbook_steps(prompt.text)
            if steps <= 0:
                continue  # a promptbook without a step cannot run
            option = ("one", {}) if steps == 1 else ("default", {"k": steps})
            starter = b.card("saved_book", {"name": prompt.title}, reason=_first_reason(
                b, "saved_book", [option]), ref=ref)
        else:
            starter = b.card("saved_prompt", {"name": prompt.title}, ref=ref)
        if starter is not None:
            return _Built(StarterCandidate("saved_prompt", starter))
    return _Built()


class _RowSnapshot:
    """A read-only page source over rows already read from a store, so the aggregate
    engine's own fold can run over them in a worker thread (with its own event loop)."""

    def __init__(self, rows: list[Any]) -> None:
        self.rows = rows

    async def scan_page(self, *, limit: int = 1000, cursor: Any = None, created_from: Any = None,
                        created_to: Any = None, raw: bool = False, statuses: Any = None,
                        newest_first: bool = False, fields: Any = None,
                        ) -> tuple[list[Any], Any | None, int | None, str]:
        start = int(cursor or 0)
        page = self.rows[start:start + max(1, int(limit))]
        after = start + len(page)
        return page, (after if after < len(self.rows) else None), len(self.rows), "point_in_time"


def _fold_snapshot(rows: list[Any], spec: Any) -> Any:
    """``fold_cases`` over ``rows`` on this (worker) thread's own event loop."""
    from .case_aggregate import fold_cases

    return asyncio.run(fold_cases(_RowSnapshot(rows), spec))


async def aggregate_off_loop(store: Any, spec: Any, *,
                             pause: Callable[[], Awaitable[None]] | None = None) -> Any:
    """``aggregate_cases(store, spec)`` with its per-row work off the event loop.

    The store's own push-down answers when it can. Otherwise the rows of the spec's
    window are read here page by page (only the fields the fold reads, the same
    transfer hint the fold sends; ``pause``, optional, is awaited after every page and
    before the fold) and the aggregate engine's own ``fold_cases`` folds them in a
    worker thread, so the figures are exactly the fold's. The result is not exact when
    the read did not complete. Count-style specs without buckets only."""
    from .case_aggregate import (
        AggregateResult,
        _raw_projection,
        _scan_statuses,
        normalise_case_filters,
        scan_cases,
        validate_case_spec,
    )

    validate_case_spec(spec)
    if "open_now" in spec.metrics or spec.bucket:
        raise ValueError("aggregate_off_loop folds count-style specs without buckets only")
    pushdown = getattr(store, "aggregate", None)
    if callable(pushdown):
        try:
            pushed = await pushdown(spec)
        except NotImplementedError:
            pushed = None
        except Exception as exc:  # noqa: BLE001 -- a push-down glitch falls back to the fold
            logger.debug("chat starters: push-down failed, folding instead (%s)", type(exc).__name__)
            pushed = None
        if isinstance(pushed, AggregateResult):
            return pushed
    norm = normalise_case_filters(spec.filters or {})
    fields = _raw_projection(spec, norm)
    rows: list[Any] = []

    async def keep(page: list[Any]) -> None:
        if fields is None:
            rows.extend(page)
        else:
            for row in page:
                rows.append({k: row[k] for k in fields if k in row} if isinstance(row, dict) else row)
        if pause is not None:
            await pause()

    window = spec.window
    outcome = await scan_cases(
        store, keep, raw=True, statuses=_scan_statuses(norm), fields=fields, page_size=SLOW_PAGE,
        created_from=window.start, created_to=None if window.open_end else window.end,
    )
    result = await asyncio.to_thread(_fold_snapshot, rows, spec)
    if not outcome.complete:
        result.exact = False
        result.partial = True
        result.error = outcome.error
    if outcome.consistency != "point_in_time":
        result.consistency = outcome.consistency
    result.scanned = outcome.scanned
    return result


def hunt_window(tz: str, now: datetime) -> Any:
    """"The last 7 days" exactly as the chat counts it (§3.3, §3.4, §3.7): today and the
    six days before it from local midnight in the operator time zone
    (``time_windows.align_whole_periods``, the window ``case_stats`` and
    ``search_cases`` count for ``now-7d``), so the count the hunt card states is the
    count its answer looks up for the window the card names."""
    from .time_windows import align_whole_periods, resolve_window

    return align_whole_periods(resolve_window(f"now-{HUNT_WINDOW.days}d", tz=tz, now=now))


async def _hunt_signal(store: Any, tz: str, now: datetime, *,
                       pause: Callable[[], Awaitable[None]] | None = None) -> tuple[str, int] | None:
    """The most common ATT&CK technique of the cases created in the last 7 days
    (:func:`hunt_window`), when at least :data:`HUNT_MIN_CASES` cases carry it and it is
    in the bundled corpus (an exact aggregate, folded off the event loop), else None."""
    from .case_aggregate import CaseAggregateSpec

    result = await aggregate_off_loop(store, CaseAggregateSpec(
        window=hunt_window(tz, now), group_by=("mitre_technique",),
    ), pause=pause)
    if not result.exact or result.partial:
        return None
    for group in result.groups:
        technique = (group.get("key") or {}).get("mitre_technique")
        n = int(group["metrics"].get("count") or 0)
        if not isinstance(technique, str) or not technique:
            continue
        if n < HUNT_MIN_CASES:
            return None  # groups come largest first
        if text.ref_value("technique", technique) == technique:
            return technique, n
    return None


async def _family_hunt(b: _Build) -> _Built:
    from . import mitre

    store, tz = b.ctx.cases, b.tz_name
    reading = b.slow("hunt", lambda now, pause: _hunt_signal(store, tz, now, pause=pause))
    if reading is None or reading.value is None:
        return _Built()
    technique, n = reading.value
    meta = mitre.technique(technique) or {}
    name = str(meta.get("name") or "").strip()
    options: list[tuple[str, Mapping[str, Any]]] = []
    if name:
        options.append(("named", {"technique_name": name}))
    options.append(("default", {}))
    multiplier, level = family_urgency("hunt")
    starter = b.card("hunt", {"technique": technique, "n": n}, reason=_first_reason(b, "hunt", options), urgency=level)
    if starter is None:
        return _Built()
    # The count is exact as of the reading (at most SLOW_MAX_AGE_S old): the card says so.
    starter = starter.model_copy(update={"as_of": text_iso(reading.measured_at)})
    return _Built(StarterCandidate("hunt", starter, urgency=multiplier, urgency_level=level))


async def _family_approvals(b: _Build) -> _Built:
    from .views import proposal_public

    if b.ctx.proposals is None:
        return _Built()
    pending = [proposal_public(p) for p in await b.ctx.proposals.list(status="pending")]
    pending = [p for p in pending if not p.get("expired")]
    if not pending:
        return _Built()
    times = [t for t in (_ts(p.get("created_at")) for p in pending) if t is not None]
    oldest, newest = (min(times), max(times)) if times else (None, None)
    multiplier, level = family_urgency("approvals")
    # No proposal has a readable creation time: "Waiting for approval" (never blank).
    options: list[tuple[str, Mapping[str, Any]]] = [("default", {"age": b.age(oldest)})] if oldest else []
    options.append(("waiting", {}))
    if len(pending) == 1:
        starter = b.card("approvals_one", reason=_first_reason(b, "approvals_one", options), urgency=level)
    else:
        starter = b.card("approvals", {"n": len(pending)}, reason=_first_reason(b, "approvals", options),
                         urgency=level)
    if starter is None:
        return _Built()
    return _Built(StarterCandidate("approvals", starter, urgency=multiplier, urgency_level=level,
                                   signal_at=newest,
                                   newer_than_baseline=bool(b.baseline and newest and newest > b.baseline)))


#: The span ``soc_metrics(kind=auto_close_health)`` compares when no window is asked
#: for (its default 24 hours; the tool narrows a window to whole hours).
PLATFORM_WINDOW_HOURS = 24


async def _platform_status(store: Any, policy: Any, now: datetime, *,
                           pause: Callable[[], Awaitable[None]] | None = None) -> str | None:
    """The ``status`` that ``soc_metrics(kind=auto_close_health)`` reports with no
    window asked for: ``engine.metrics.auto_close_health`` over the newest
    ``CASE_SCAN_LIMIT`` cases (the shared case page the tool reads), the store's total,
    the default 24 hours ending ``now`` and the auto-close policy. The page is read here
    page by page with validation and the computation in worker threads, so the reading
    never stalls the event loop. None when the store did not answer, a stored document
    did not validate (the tool's page read fails then too) or the newest-first order is
    not available."""
    from ..agents.chat_tools.cases import CASE_SCAN_LIMIT
    from .metrics import auto_close_health

    population, ordered = await _read_newest(store, limit=CASE_SCAN_LIMIT, statuses=None, fields=None,
                                             pause=pause, page_size=SLOW_PAGE)
    if population.bad:
        return None
    _first, total = await store.list(limit=1)
    total = int(total or 0)
    if total > len(population.cases) and not ordered:
        return None  # not the newest page: no reading rather than a wrong one
    health = await asyncio.to_thread(
        auto_close_health, population.cases, window_hours=PLATFORM_WINDOW_HOURS, now=now,
        policy=policy, store_total=total,
    )
    return str((health or {}).get("status") or "") or None


async def _family_platform(b: _Build) -> _Built:
    store, policy = b.ctx.cases, getattr(b.prefs, "auto_close", None)
    reading = b.slow("platform", lambda now, pause: _platform_status(store, policy, now, pause=pause))
    if reading is None or reading.value not in PLATFORM_DEGRADED:
        return _Built()
    multiplier, level = family_urgency("platform")
    starter = b.card("platform", urgency=level)
    if starter is None:
        return _Built()
    return _Built(StarterCandidate("platform", starter, urgency=multiplier, urgency_level=level))


async def _family_demo(b: _Build) -> _Built:
    if not b.demo:
        return _Built()
    starter = b.card("demo")
    return _Built(StarterCandidate("demo", starter)) if starter is not None else _Built()


#: The signal families (§3.3) in FAMILY_ORDER.
FAMILIES: Mapping[str, Callable[[_Build], Awaitable[_Built]]] = {
    "needs_human": _family_needs_human,
    "sla": _family_sla,
    "my_cases": _family_my_cases,
    "new_cases": _family_new_cases,
    "shift": _family_shift,
    "silent_source": _family_silent_source,
    "volume_change": _family_volume_change,
    "campaign": _family_campaign,
    "noisy_rule": _family_noisy_rule,
    "approvals": _family_approvals,
    "budget": _family_budget,
    "continue": _family_continue,
    "platform": _family_platform,
    "hunt": _family_hunt,
    "weekly": _family_weekly,
    "saved_prompt": _family_saved_prompt,
    "demo": _family_demo,
}

_WARNED: set[tuple[str, str]] = set()


def _warn_once(family: str, exc: BaseException) -> None:
    """A family that raised or timed out is skipped and logged ONCE at warning level
    (per family and error class, per process; later repeats log at debug)."""
    kind = "timeout" if isinstance(exc, asyncio.TimeoutError) else type(exc).__name__
    if (family, kind) in _WARNED:
        logger.debug("chat starters: family %s skipped (%s)", family, kind)
        return
    _WARNED.add((family, kind))
    logger.warning("chat starters: family %s skipped (%s)", family, kind)


#: Families that read the shared open-case population. Their own time limit starts
#: once the population has been read (§3.13: families run "after the shared population
#: read"), so a slow but successful read never silently drops them.
POPULATION_FAMILIES: frozenset[str] = frozenset({"needs_human", "my_cases", "sla", "campaign"})
#: Kept free at the end of the build for ranking and assembly.
BUILD_MARGIN_S = 0.1


async def _run_family(b: _Build, family: str) -> _Built:
    fn = FAMILIES[family]
    try:
        if family in POPULATION_FAMILIES:
            # The shared read is bounded by the build, not by this family's own limit.
            # A failed read is the family's failure (it is skipped and logged once).
            await asyncio.wait_for(b.population(), b.remaining())
        budget = min(FAMILY_TIMEOUT_S, b.remaining())
        if budget <= 0:
            raise asyncio.TimeoutError()
        return await asyncio.wait_for(fn(b), budget)
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # noqa: BLE001 -- isolated: never hides the other families
        b.degraded = True
        _warn_once(family, exc)
        return _Built()


async def _run_families(b: _Build, families: Sequence[str]) -> dict[str, _Built]:
    runnable = [f for f in families if b.eligible(f)]
    if any(f in POPULATION_FAMILIES for f in runnable):
        b.prefetch_cutoff()  # the case-number cutoff read runs alongside the population read
    results = await asyncio.gather(*(_run_family(b, f) for f in runnable))
    return dict(zip(runnable, results))


async def _fresh_install(b: _Build) -> bool:
    """No enabled source and no case at all (§3.3 onboarding); never in Demo Mode."""
    if b.demo or any(getattr(s, "enabled", False) for s in getattr(b.prefs, "sources", None) or []):
        return False
    try:
        _cases, total = await asyncio.wait_for(b.ctx.cases.list(limit=1), FAMILY_TIMEOUT_S)
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # noqa: BLE001 -- unknown: not a fresh install
        _warn_once("fresh_install", exc)
        return False
    return int(total or 0) == 0


async def _evergreen(b: _Build, *, fresh: bool) -> list[StarterCandidate]:
    out: list[StarterCandidate] = []
    families = ONBOARDING_ORDER if fresh else EVERGREEN_ORDER
    for family in families:
        if not b.eligible(family):
            continue
        if family == "triage":
            try:
                pop = await asyncio.wait_for(b.population(), max(0.0, b.remaining()))
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                b.degraded = True
                _warn_once("triage", exc)
                continue
            if not pop.cases:
                continue
        starter = b.card(family)
        if starter is not None:
            out.append(StarterCandidate(family, starter))
    return out


def _catch_up(b: _Build, results: Mapping[str, _Built], baseline: datetime) -> ChatCatchUp | None:
    """The catch-up line from the families' clauses (§3.6), or None without a clause."""
    items: list[tuple[str, ChatStarter]] = []
    hidden = b.user_state.dismissed_families(b.now)  # "Hide" hides the family everywhere (§3.9)
    for family in CATCHUP_FAMILIES:
        built = results.get(family)
        if family in hidden or built is None or not built.clause or built.candidate is None:
            continue
        starter = built.candidate.starter
        if starter.action != "send" or len(built.clause) > text.CLAUSE_MAX_CHARS:
            continue
        items.append((built.clause, starter))
    label = b.since_label(baseline)
    kept = text.fit_catch_up(label, items, lambda item: item[0])
    if not kept:
        return None
    try:
        return ChatCatchUp(
            since=text_iso(baseline), since_label=label,
            clauses=[ChatCatchUpClause(text=clause, starter=starter) for clause, starter in kept],
        )
    except ValueError:
        return None


#: In Demo Mode the ``demo`` card is always among the first cards a wide lane shows
#: (§3.11 "the same families over the seeded stores, plus the demo card").
DEMO_CARD_SLOT = 3


def _keep_demo_card(ranked: list[StarterCandidate], candidates: Sequence[StarterCandidate],
                    user_state: StarterUserState | None, now: datetime) -> list[StarterCandidate]:
    demo = next((c for c in candidates if c.family == "demo"), None)
    if demo is None or (user_state is not None and "demo" in user_state.dismissed_families(now)):
        return ranked
    others = [c for c in ranked if c.family != "demo"]
    position = next((i for i, c in enumerate(ranked) if c.family == "demo"), None)
    if position is not None and position <= DEMO_CARD_SLOT:
        return ranked
    others.insert(min(DEMO_CARD_SLOT, len(others)), demo)
    return others[:MAX_STARTERS]


async def _build_home(b: _Build) -> tuple[list[ChatStarter], ChatCatchUp | None]:
    # A fresh install (no enabled source, no case) serves the onboarding cards alone
    # (§3.11): every signal family would ask about data that does not exist yet.
    fresh = await _fresh_install(b)
    results = await _run_families(b, () if fresh else FAMILY_ORDER)
    candidates = [r.candidate for r in results.values() if r.candidate is not None]
    candidates.extend(await _evergreen(b, fresh=fresh))
    ranked = rank(candidates, role=b.role, user_state=b.user_state, now=b.now, fresh_install=fresh)
    ranked = _keep_demo_card(ranked, candidates, b.user_state, b.now)
    catch_up = None
    visit_start = b.view.visit_started_at
    if (b.baseline is not None and not b.object_scoped and visit_start is not None
            and b.now - visit_start <= CATCHUP_WINDOW):
        catch_up = _catch_up(b, results, b.baseline)
    return [c.starter for c in ranked][:MAX_STARTERS], catch_up


async def _build_thread(b: _Build, conversation_id: str | None) -> ChatCatchUp | None:
    """The thread catch-up line: the thread's last answer is the baseline, and it shows
    once that answer settled :data:`THREAD_SETTLED` ago (§3.1, §3.6)."""
    store = getattr(b.state, "chat_conversations", None)
    if b.object_scoped or store is None or not conversation_id:
        return None
    conversation = await store.get(b.username, conversation_id, window=2, hydrate=False)
    answers = [m for m in (getattr(conversation, "messages", None) or []) if m.role == "assistant"]
    last = _ts(answers[-1].created_at) if answers else None
    if last is None or b.now - last < THREAD_SETTLED:
        return None
    b.baseline = last
    results = await _run_families(b, CATCHUP_FAMILIES)
    return _catch_up(b, results, last)


async def _build_case(b: _Build, case_id: str | None) -> list[ChatStarter]:
    if not case_id:
        return []
    case = await b.ctx.cases.get(case_id)
    if case is None:
        return []
    entity = getattr(case, "entity", None)
    templates = case_chip_templates(
        status=_enum(case.status), verdict=_enum(case.verdict) or None,
        has_entity=bool(str(getattr(entity, "value", "") or "").strip()),
        has_related=bool(getattr(case, "related_case_ids", None) or getattr(case, "campaign_id", None)),
        allowed=b.template_ok,
    )
    return [s for s in (b.card(t) for t in templates) if s is not None]


def _evergreen_fallback(b: _Build) -> list[ChatStarter]:
    """The static evergreen set (Demo card first), filtered to the caller's tools: the
    answer when the organisation switched dynamic starters off or the build failed."""
    out = []
    for starter in evergreen_starters(demo=b.demo):
        if b.tools_ok(starter.tools):
            out.append(starter.model_copy(update={"as_of": b.as_of, "expires_at": b.expires_at}))
    return out[:MAX_STARTERS]


def _static_answer(surface: str, *, enabled: bool, now: datetime, prefs: Any, demo: bool,
                   grants: Any) -> ChatStartersInfo:
    """The evergreen set filtered by the caller's grants alone (no tool context could be
    built), stamped like any answer; nothing for ``thread`` and ``case``."""
    from ..agents.chat_tools.registry import catalogue_infos
    from .time_windows import zone_for

    allowed = {i.name for i in catalogue_infos(grants) if i.allowed}
    as_of, expires = text_iso(now), text_iso(now + timedelta(seconds=EXPIRES_AFTER_S))
    starters = [
        s.model_copy(update={"as_of": as_of, "expires_at": expires})
        for s in evergreen_starters(demo=demo) if all(t in allowed for t in s.tools)
    ] if surface == "home" else []
    _zone, tz_name = zone_for(getattr(getattr(prefs, "sla", None), "timezone", None))
    return ChatStartersInfo(surface=surface, enabled=enabled, as_of=as_of, expires_at=expires,
                            timezone=tz_name, starters=starters[:MAX_STARTERS], catch_up=None)


def _caller(request: Any) -> tuple[str, str, bool]:
    """``(username, role, auth on)`` of the request ("" and "" when auth is off)."""
    from ..api.deps import current_user

    try:
        user = current_user(request)
    except Exception:  # noqa: BLE001 -- treated as the no-auth profile
        user = None
    if user is None:
        return "", "", False
    return str(user.username or ""), _enum(getattr(user, "role", "")), True


def object_scoped(state: Any, role: str) -> bool:
    """Object (row) scoping is on for ``role``: every case family and the catch-up
    line are skipped, fail closed (§3.3 "Object scope"). ``super_admin`` is never
    scoped (``can_object``); an unreadable configuration counts as scoped."""
    from ..rbac.policy import object_scoping_enabled

    rbac = getattr(getattr(state, "prefs", None), "rbac", None)
    try:
        if not object_scoping_enabled(rbac):
            return False
        if role == "super_admin":
            return False
        from ..rbac.policy import _object_scope_conditions

        return bool(_object_scope_conditions(rbac, role, "cases", "read"))
    except Exception:  # noqa: BLE001 -- fail closed
        return True


@dataclass
class BuildStatus:
    """What a caller learns about a build besides its answer (optional, additive):
    ``degraded`` is True when a family raised or timed out, a shared read failed, the
    caller's starter state could not be read or the whole build fell back. The answer is
    still served; the route does not cache it."""

    degraded: bool = False


async def build_starters(
    state: AppState, request: Any, *, surface: StarterSurface,
    conversation_id: str | None = None, case_id: str | None = None,
    now: datetime | None = None, user_state: StarterUserState | None = None,
    status: BuildStatus | None = None,
) -> ChatStartersInfo:
    """``GET /api/chat/starters`` for the caller (§3.2.2). A pure read: no write, no
    model call, no audit row, no UsageDoc. Always returns: a family that raises or
    times out is skipped (§3.13), and a total failure returns the evergreen set with
    ``catch_up`` None.

    ``home``: up to 6 ranked cards and the catch-up line; ``thread``: no cards, the
    thread's catch-up line; ``case``: the Case Manager chips of ``case_id``. The route
    checks ownership (404s) and caches the answer; ``user_state`` (optional, additive)
    is the caller's starter state when the route already read it, and ``status``
    (optional, additive) receives whether the build was degraded."""
    from ..agents.chat_tools.registry import catalogue_infos

    status = status if status is not None else BuildStatus()
    as_of = _utc(now)
    prefs = getattr(state, "execution_prefs", None)
    cfg = getattr(prefs, "chat_agent", None)
    enabled = bool(getattr(cfg, "dynamic_starters", True))
    username, role, auth_on = _caller(request)
    grants = await state.chat_grants(request)
    try:
        ctx = await state.build_chat_tool_context(request, None, grants=grants, prefs=prefs)
    except Exception as exc:  # noqa: BLE001 -- always 200: the static set, by grants alone
        _warn_once("context", exc)
        status.degraded = True
        return _static_answer(surface, enabled=enabled, now=as_of, prefs=prefs,
                              demo=bool(getattr(state, "demo_active", False)), grants=grants)
    if user_state is None:
        try:
            user_state = await state.chat_starters.load(username)
        except Exception as exc:  # noqa: BLE001 -- no state: the first-visit view
            _warn_once("state", exc)
            status.degraded = True
            user_state = StarterUserState()
    build = _Build(
        state=state, request=request, ctx=ctx, now=as_of, surface=surface, user_state=user_state,
        infos={info.name: info for info in catalogue_infos(grants, ctx)}, username=username,
        role=role, auth_on=auth_on, object_scoped=object_scoped(state, role),
        conversation_id=conversation_id,
    )

    def info(starters: list[ChatStarter], catch_up: ChatCatchUp | None) -> ChatStartersInfo:
        return ChatStartersInfo(
            surface=surface, enabled=enabled, as_of=build.as_of, expires_at=build.expires_at,
            timezone=build.tz_name, starters=starters[:MAX_STARTERS], catch_up=catch_up,
        )

    async def run() -> ChatStartersInfo:
        if surface == "case":
            return info(await _build_case(build, case_id), None)
        if not enabled:
            return info(_evergreen_fallback(build) if surface == "home" else [], None)
        if surface == "thread":
            return info([], await _build_thread(build, conversation_id))
        starters, catch_up = await _build_home(build)
        return info(starters, catch_up)

    # Families answer by this loop time, leaving BUILD_MARGIN_S to rank and assemble
    # inside the whole-build bound.
    build.deadline = asyncio.get_running_loop().time() + BUILD_TIMEOUT_S - BUILD_MARGIN_S
    memo = slow_signals(state)
    memo.active_builds += 1  # a background refresh gives way while this runs
    try:
        return await asyncio.wait_for(run(), BUILD_TIMEOUT_S)
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # noqa: BLE001 -- always 200: the evergreen set
        _warn_once("build", exc)
        build.degraded = True
        return info(_evergreen_fallback(build) if surface == "home" else [], None)
    finally:
        memo.active_builds = max(0, memo.active_builds - 1)
        status.degraded = status.degraded or build.degraded
        build.close()
        build.start_deferred()


__all__ = [
    "BASE",
    "BUILD_TIMEOUT_S",
    "BuildStatus",
    "CACHE_TTL_S",
    "CASE_FAMILIES",
    "CATCHUP_WINDOW",
    "DISMISS_FOR",
    "EVERGREEN_FAMILIES",
    "EVERGREEN_ORDER",
    "EVERGREEN_ORDER_AUDITOR",
    "EXPIRES_AFTER_S",
    "FAMILY_NEEDS",
    "FAMILY_ORDER",
    "FAMILY_TIMEOUT_S",
    "MAX_SIGNALS",
    "MAX_STARTERS",
    "ONBOARDING_FAMILIES",
    "ONBOARDING_ORDER",
    "OPEN_POPULATION_LIMIT",
    "ROLE_PREFERENCES",
    "SHIFT_GAP",
    "STATE_MAX_BYTES",
    "STATE_MAX_DISMISSED",
    "STATE_MAX_KEYS",
    "VISIT_GAP",
    "FamilyNeeds",
    "StarterCandidate",
    "StarterKeyStats",
    "StarterUserState",
    "VisitView",
    "aggregate_off_loop",
    "build_starters",
    "case_chip_templates",
    "close_slow_signals",
    "evergreen_order",
    "evergreen_starters",
    "family_urgency",
    "hunt_window",
    "rank",
    "record_dismissed",
    "record_used",
    "record_viewed",
    "score",
    "starter_from_template",
    "starter_key",
    "settle_slow_signals",
    "state_size",
    "text_iso",
    "visit_view",
    "volume_change",
]
