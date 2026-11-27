"""Daily CAMPAIGN correlation — cross-case grouping (Round 4, Wave 3).

A scheduled, DETERMINISTIC, $0 pass that folds RELATED cases into running
:class:`app.models.Campaign` incidents for the UI. It is a READ-TIME AGGREGATOR
(the same shape as :mod:`app.engine.shift_report`): it reads already-persisted
Cases and returns campaigns — it NEVER investigates, NEVER calls an LLM, and NEVER
touches the deterministic close/escalate machinery.

HOW IT CLUSTERS
---------------
Build an UNDIRECTED graph whose NODES are cases. Two cases share an EDGE when they
share a cross-source ENTITY — the SAME ``"xsrc"``-namespace, time-bucketed entity
logic the existing cross-source pass uses
(:func:`app.engine.signatures.cross_source_signature`), so we don't invent a second
entity model — OR a shared MITRE technique. A CONNECTED COMPONENT with ``>= 2``
cases AND at least ``>= 1`` shared entity within it becomes a Campaign (a component
tied together ONLY by MITRE, with no shared entity, is NOT a campaign; a single-case
component is NOT a campaign).

Each case exposes its cross-source entity keys via its PRIMARY ``entity`` plus any
``related_case_ids`` links already computed by the opt-in cross-source pass — all
plain, source-derived DATA (#9); we never build a prompt over them.

IDENTITY / IDEMPOTENCY
----------------------
A campaign's ``id`` is a STABLE hash of its members' sorted ``cluster_signature``
values (``campaign-<hash>``), so the SAME set of member cases ALWAYS folds into the
SAME campaign id — re-running the pass upserts in place, never duplicates. A
human-facing ``name``/display number is minted from the :mod:`app.engine.case_id`
KV sequence with a ``campaign-`` template (best-effort; the content-hash id is the
idempotency key, not the sequence).

THREE HARD RAILS
----------------
1. #3 — this module NEVER imports ``case_manager`` / calls ``decide()``. It is a
   read-time aggregator; a campaign can NEVER close/escalate a member case.
2. #4 — a Campaign only REFERENCES ``case_ids``. It NEVER recomputes or mutates a
   case's ``cluster_signature``; adding/removing a case from a campaign does not
   change that case (its identity + status are untouched). A NEEDS_HUMAN case can
   join a campaign and stays NEEDS_HUMAN.
3. ADVISORY — the rolled-up ``severity_rollup`` + an attention item are
   presentation/reporting only.
"""

from __future__ import annotations

import hashlib
import logging
from collections import defaultdict
from typing import Any, Iterable

from ..config import Preferences
from ..constants import EntityType
from ..models import Campaign, CampaignEntity, Case
from ..utils import iso_now, parse_es_timestamp
from .priority import band_of_case
from .signatures import cross_source_signature

logger = logging.getLogger("tlsoc.engine.campaigns")

# How far back the trailing-window read reaches, per configured cadence. Deliberately
# a small multiple of the cadence so a "daily" pass groups the last day's cases, a
# "weekly" the last week, etc. — bounded so a busy tenant's read stays paged.
_WINDOW_DAYS_BY_CADENCE: dict[str, int] = {
    "hourly": 1,
    "daily": 1,
    "weekly": 7,
    "manual": 30,
}

# The default entity-binding time bucket (seconds). We reuse the operator's
# cross-source window when one is configured (same source-agnostic bucket math), else
# fall back to a day so a campaign's day-scale narrative binds entities seen within
# the same day rather than only the same 5-minute cross-source window.
_DEFAULT_ENTITY_WINDOW_SECONDS = 86_400

# Coarse severity-band → rank so we can roll a campaign's headline severity up to the
# MAX of its members. Plain display labels (#3-safe advisory).
_SEVERITY_RANK: dict[str, int] = {"critical": 4, "high": 3, "medium": 2, "low": 1, "info": 0}
_RANK_SEVERITY: dict[int, str] = {v: k for k, v in _SEVERITY_RANK.items()}

# Page size for the trailing-case read (NOT a naive 200-cap — we page until the
# window is exhausted; see :func:`_read_recent_cases`).
_PAGE_SIZE = 500
# Hard ceiling on cases scanned per pass, so a pathological tenant can't unbound the
# in-memory graph. Bounded + deterministic (newest-first read).
_MAX_CASES = 20_000
# Hard ceiling on the size of a promoted campaign component (audit #22). A larger
# component is almost certainly a hub-entity artifact, not one real campaign.
_MAX_CAMPAIGN_CASES = 200


def _entity_window_seconds(prefs: Preferences) -> int:
    """The source-agnostic entity time-bucket (seconds) for binding cases.

    Reuse the operator's cross-source window when they've tuned one, else the daily
    default — so entity binding uses the SAME ``"xsrc"`` bucket math the cross-source
    pass uses, never a second/invented scheme."""
    try:
        cfg = prefs.cross_source_correlation
        if cfg is not None and cfg.enabled:
            return max(1, int(cfg.time_window_seconds))
    except Exception:  # noqa: BLE001 — advisory; degrade to the default
        pass
    return _DEFAULT_ENTITY_WINDOW_SECONDS


def _case_millis(case: Case) -> int:
    """A representative epoch-millis time for a case (for the entity time bucket).

    Prefers the last-updated instant, then created; 0 when unparseable (a case with
    no usable time still binds on bucket 0 — never dropped)."""
    for raw in (case.updated_at, case.created_at):
        dt = parse_es_timestamp(raw)
        if dt is not None:
            return int(dt.timestamp() * 1000)
    return 0


def _case_entities(case: Case) -> set[tuple[str, str]]:
    """The set of ``(entity_type, value)`` cross-source keys a case exposes.

    A case does not carry its member events post-persist, so we use its PRIMARY
    entity (the reliable, deterministic key) — the campaign pass binds cases that
    share that primary entity within a time bucket, reusing the cross-source entity
    notion rather than inventing a new one. All plain DATA (#9)."""
    out: set[tuple[str, str]] = set()
    ent = getattr(case, "entity", None)
    if ent is not None:
        et = getattr(ent.type, "value", ent.type)
        val = (ent.value or "").strip()
        if et and val and str(et) != EntityType.RULE.value:
            # RULE is a per-window grouping fallback, not a real shared indicator —
            # excluding it keeps a campaign a genuine "shared entity" narrative.
            out.add((str(et), val))
    return out


def _entity_bucket_keys(case: Case, window_seconds: int) -> set[str]:
    """The ``"xsrc"`` time-bucketed keys this case binds on.

    Two cases sharing any of these keys share an ENTITY edge in the campaign graph.
    Reuses :func:`cross_source_signature` (namespace ``"xsrc"``, time-bucketed) so the
    binding is the SAME source-agnostic notion the cross-source pass uses — never a
    second entity model, and never a ``cluster_signature`` (#4)."""
    ts = _case_millis(case)
    keys: set[str] = set()
    for (et, val) in _case_entities(case):
        keys.add(cross_source_signature(et, val, ts, window_seconds))
    return keys


def _case_mitre(case: Case) -> set[str]:
    """The set of MITRE technique ids on a case (normalised, plain data)."""
    out: set[str] = set()
    for tech in getattr(case, "mitre", None) or []:
        t = str(tech or "").strip()
        if t:
            out.add(t.upper())
    return out


class _DisjointSet:
    """A tiny union-find over case ids (path-compression + union-by-size). Pure,
    deterministic — the graph's connected components fall out of :meth:`groups`."""

    def __init__(self) -> None:
        self._parent: dict[str, str] = {}
        self._size: dict[str, int] = {}

    def add(self, x: str) -> None:
        if x not in self._parent:
            self._parent[x] = x
            self._size[x] = 1

    def find(self, x: str) -> str:
        root = x
        while self._parent[root] != root:
            root = self._parent[root]
        # Path compression.
        while self._parent[x] != root:
            self._parent[x], x = root, self._parent[x]
        return root

    def union(self, a: str, b: str) -> None:
        self.add(a)
        self.add(b)
        ra, rb = self.find(a), self.find(b)
        if ra == rb:
            return
        if self._size[ra] < self._size[rb]:
            ra, rb = rb, ra
        self._parent[rb] = ra
        self._size[ra] += self._size[rb]

    def groups(self) -> dict[str, list[str]]:
        out: dict[str, list[str]] = defaultdict(list)
        for x in self._parent:
            out[self.find(x)].append(x)
        return out


def _campaign_id(cluster_signatures: Iterable[str]) -> str:
    """A STABLE, idempotent campaign id from the sorted member cluster signatures.

    The SAME set of member clusters ALWAYS yields the SAME id, so re-running the pass
    upserts in place. It hashes the cases' ``cluster_signature`` values (which are
    themselves #4-frozen) but NEVER recomputes/alters any signature."""
    norm = "|".join(sorted({str(s) for s in cluster_signatures if s}))
    digest = hashlib.sha256(norm.encode("utf-8")).hexdigest()[:32]
    return f"campaign-{digest}"


def _rollup_severity(cases: list[Case], prefs: Any = None) -> str | None:
    """The MAX advisory severity band across member cases (plain label, #3-safe).

    Resolved through :func:`app.engine.priority.band_of_case`, not read off
    ``Case.severity_band`` — that field is a READ-TIME presentation value no production
    write path persists, so the direct read rolled every campaign up to ``None``.
    ``prefs`` is optional (it only resolves the source's declared severity ceiling)."""
    best = -1
    for case in cases:
        band = str(band_of_case(case, prefs) or "").strip().lower()
        rank = _SEVERITY_RANK.get(band)
        if rank is not None and rank > best:
            best = rank
    return _RANK_SEVERITY.get(best) if best >= 0 else None


def _rollup_entities(cases: list[Case], window_seconds: int) -> list[CampaignEntity]:
    """The SHARED entities that bind the campaign — those present on >= 2 members.

    Only entities shared by at least two member cases (within the same time bucket)
    are the campaign's binding indicators; a solitary member's own entity is not a
    "campaign" entity. Deterministically sorted for a stable, idempotent list."""
    # (entity_type, value) -> the set of member case ids sharing it in a common bucket.
    by_entity: dict[tuple[str, str], set[str]] = defaultdict(set)
    # entity -> bucket -> member ids (so "shared" means shared WITHIN a bucket).
    by_bucket: dict[tuple[str, str, str], set[str]] = defaultdict(set)
    for case in cases:
        ts = _case_millis(case)
        for (et, val) in _case_entities(case):
            bkey = cross_source_signature(et, val, ts, window_seconds)
            by_bucket[(et, val, bkey)].add(case.case_id)
    for (et, val, _bkey), ids in by_bucket.items():
        if len(ids) >= 2:
            by_entity[(et, val)].update(ids)
    out = [
        CampaignEntity(entity_type=et, value=val)
        for (et, val) in sorted(by_entity.keys())
    ]
    return out


def _rollup_mitre(cases: list[Case]) -> list[str]:
    """The union of MITRE techniques across member cases (sorted, deduped)."""
    techs: set[str] = set()
    for case in cases:
        techs |= _case_mitre(case)
    return sorted(techs)


def _time_span(cases: list[Case]) -> tuple[str | None, str | None]:
    """The (earliest created, latest updated/created) ISO timestamps of the members."""
    firsts: list[tuple[Any, str]] = []
    lasts: list[tuple[Any, str]] = []
    for case in cases:
        cdt = parse_es_timestamp(case.created_at)
        if cdt is not None:
            firsts.append((cdt, case.created_at))
        udt = parse_es_timestamp(case.updated_at) or cdt
        if udt is not None:
            lasts.append((udt, case.updated_at or case.created_at))
    first = min(firsts, key=lambda t: t[0])[1] if firsts else None
    last = max(lasts, key=lambda t: t[0])[1] if lasts else None
    return first, last


def build_campaigns(cases: list[Case], prefs: Preferences) -> list[Campaign]:
    """The PURE clustering core: fold a snapshot of cases into campaigns.

    DETERMINISTIC + side-effect-free (no I/O, no LLM, no ``decide()``). Nodes are
    cases; edges are a shared cross-source entity (``"xsrc"`` time-bucketed) OR a
    shared MITRE technique. A connected component with >= 2 cases AND >= 1 shared
    entity becomes a :class:`Campaign` (single-case components / entity-less
    MITRE-only components are NOT campaigns). Idempotent: campaign identity is the
    content hash of its sorted member ``cluster_signature`` values."""
    if not cases:
        return []
    window_seconds = _entity_window_seconds(prefs)

    by_id: dict[str, Case] = {}
    for case in cases:
        cid = getattr(case, "case_id", None)
        if cid:
            by_id[str(cid)] = case
    if not by_id:
        return []

    dsu = _DisjointSet()
    for cid in by_id:
        dsu.add(cid)

    # Entity edges: cases sharing an "xsrc" time-bucketed entity key.
    entity_to_cases: dict[str, list[str]] = defaultdict(list)
    for cid, case in by_id.items():
        for ekey in _entity_bucket_keys(case, window_seconds):
            entity_to_cases[ekey].append(cid)
    for ids in entity_to_cases.values():
        if len(ids) < 2:
            continue
        anchor = ids[0]
        for other in ids[1:]:
            dsu.union(anchor, other)

    # MITRE is an ADVISORY OVERLAY only — NOT a graph edge (audit #22). A single common
    # technique (e.g. T1078 Valid Accounts, present in a large fraction of cases) would
    # otherwise union hundreds of unrelated cases into one giant "campaign". The spec
    # defines a campaign by SHARED ENTITY (see the >= 1-shared-entity guard below), and
    # a component tied together only by MITRE has no shared entity, so MITRE edges could
    # only ever over-cluster. Techniques are still rolled up onto the campaign below.

    campaigns: list[Campaign] = []
    for _root, member_ids in dsu.groups().items():
        if len(member_ids) < 2:
            continue  # a single-case component is NOT a campaign
        if len(member_ids) > _MAX_CAMPAIGN_CASES:
            # A component this large is almost certainly a hub-entity artifact (a shared
            # gateway IP / service account in thousands of cases), not one real campaign.
            # Skip promoting it rather than emit a misleading mega-campaign.
            logger.warning(
                "campaign component of %d cases exceeds cap %d; skipping (hub-entity "
                "artifact) — root=%s", len(member_ids), _MAX_CAMPAIGN_CASES, _root,
            )
            continue
        members = [by_id[m] for m in member_ids if m in by_id]
        shared_entities = _rollup_entities(members, window_seconds)
        if not shared_entities:
            # A component tied together ONLY by shared MITRE (no shared entity) is
            # NOT a campaign — the spec requires >= 1 shared entity.
            continue
        signatures = [c.cluster_signature for c in members if getattr(c, "cluster_signature", None)]
        campaign_id = _campaign_id(signatures)
        first_seen, last_seen = _time_span(members)
        case_ids = sorted(c.case_id for c in members)
        campaigns.append(
            Campaign(
                id=campaign_id,
                name="",  # a human display number is minted by the store-backed pass
                case_ids=case_ids,
                entities=shared_entities,
                mitre=_rollup_mitre(members),
                first_seen=first_seen,
                last_seen=last_seen,
                severity_rollup=_rollup_severity(members, prefs),
            )
        )
    # Deterministic order (stable id) for a byte-identical re-run.
    campaigns.sort(key=lambda c: c.id)
    return campaigns


async def _read_recent_cases(cases_store: Any, prefs: Preferences) -> list[Case]:
    """Page the trailing-window case read (NOT a naive 200-cap).

    Reads newest-first pages until the configured trailing window is exhausted (or the
    hard ceiling is hit), so a busy tenant's daily pass sees ALL of the day's cases,
    not just the first page. Best-effort: a store error stops paging (returns what we
    have). NEVER raises."""
    cadence = str(getattr(getattr(prefs, "campaign", None), "cadence", "daily") or "daily")
    window_days = _WINDOW_DAYS_BY_CADENCE.get(cadence, 1)
    cutoff_ms = int(iso_now_millis()) - window_days * 86_400 * 1000

    collected: list[Case] = []
    offset = 0
    while len(collected) < _MAX_CASES:
        try:
            page, _total = await cases_store.list(
                limit=_PAGE_SIZE, offset=offset, sort_field="created_at", sort_order="desc"
            )
        except Exception as exc:  # noqa: BLE001 — read is best-effort
            logger.warning("Campaign case read failed at offset %d (%s); stopping", offset, exc)
            break
        if not page:
            break
        stop = False
        for case in page:
            created = parse_es_timestamp(case.created_at)
            if created is not None and int(created.timestamp() * 1000) < cutoff_ms:
                # Newest-first read: once we cross the trailing window we're done.
                stop = True
                break
            collected.append(case)
        if stop or len(page) < _PAGE_SIZE:
            break
        offset += _PAGE_SIZE
    return collected


def iso_now_millis() -> int:
    """Current epoch millis (a tiny helper kept module-local so the pass has no new
    import surface). Deterministic tests inject cases with explicit timestamps."""
    from ..utils import now_utc

    return int(now_utc().timestamp() * 1000)


async def correlate_campaigns(
    cases: list[Case] | None,
    prefs: Preferences,
    cases_store: Any | None = None,
) -> list[Campaign]:
    """The scheduled DETERMINISTIC campaign pass over the trailing window of CASES.

    When ``cases`` is provided it clusters exactly that snapshot (the test / caller
    supplies it). Otherwise it PAGES the trailing window from ``cases_store`` (bounded,
    newest-first, NOT a naive 200-cap). Returns the campaigns — a read-time aggregator
    like :mod:`app.engine.shift_report`; it NEVER investigates, mutates a case, calls
    an LLM (#6), touches a ``cluster_signature`` (#4), or calls ``decide()`` (#3).

    Idempotent: the same input cases always produce the same campaign ids/content, so
    a caller can upsert the result through :class:`app.stores.campaigns.CampaignStore`
    without ever creating a duplicate."""
    if cases is None:
        if cases_store is None:
            return []
        cases = await _read_recent_cases(cases_store, prefs)
    return build_campaigns(cases, prefs)
