"""Round 12 (WP-AGG): ``engine/case_aggregate`` — exact, full-population aggregates.

Three layers of proof:

1. **Semantics** on small hand-built sets: every group field, filter and metric means
   what the module docstring says, and agrees with the dashboards' own definitions in
   ``engine/metrics`` (quality partition, lifecycle percentiles, MTTA human-only) and
   with the analyst ground-truth authority (``analyst_outcomes``).
2. **Honesty**: never-drop for unreadable timestamps, the exact ``Other`` remainder,
   zero-filled buckets, partial results on a mid-scan failure, cancellation.
3. **Scale + backend parity** (P0-4 acceptance): on 12,000-case stores, the fake
   Elasticsearch push-down, the SQLite ``GROUP BY`` push-down and the fold on all three
   paths (fake ES, SQLite, a third-party repository with only the abstract surface)
   equal an INDEPENDENT brute-force count for every grouping.
"""

from __future__ import annotations

import asyncio
import random
from collections import Counter
from datetime import datetime, timedelta, timezone
from itertools import product
from typing import Any

import pytest

from app.constants import (
    CASES_WRITE_ALIAS,
    OPEN_CASE_STATUSES,
    TERMINAL_CASE_STATUSES,
    CaseStatus,
    DecisionBy,
    Disposition,
    EntityType,
    SourceSurface,
    Verdict,
)
from app.engine import metrics as M
from app.engine import mitre as mitre_engine
from app.engine.analyst_outcomes import analyst_confirmed_outcome
from app.engine.case_aggregate import (
    CASE_GROUP_FIELDS,
    CASE_METRICS,
    MISSING_BUCKET,
    OTHER_KEY,
    AggregateResult,
    AggregationCancelled,
    CaseAggregateSpec,
    aggregate_cases,
    fold_cases,
)
from app.engine.precedent import is_policy_closed
from app.engine.priority import band_of_case
from app.engine.time_windows import align_window, period_start, resolve_window
from app.es.fake import InMemoryESClient
from app.models import Case, Entity, FeedbackEntry, StatusHistoryEntry
from app.stores.base import CaseRepository
from app.stores.cases import CaseStore
from app.stores.sql import SqlCaseRepository, build_async_engine, create_all
from app.stores.sql.models import CaseRow
from app.stores.sql.repositories import _canonical_created_at, _entity_value
from app.utils import parse_es_timestamp

UTC = timezone.utc
NOW = datetime.now(UTC).replace(microsecond=0)
_ACTIVE = set(OPEN_CASE_STATUSES)
_TERMINAL = set(TERMINAL_CASE_STATUSES)


# --------------------------------------------------------------------------- #
# Case factory
# --------------------------------------------------------------------------- #
def _case(cid: str, **kw: Any) -> Case:
    base: dict[str, Any] = {
        "case_id": cid,
        "cluster_signature": f"sig-{cid}",
        "source_surface": SourceSurface.INVESTIGATE,
        "entity": Entity(type=EntityType.IP, value="10.0.0.1"),
        "created_at": (NOW - timedelta(hours=1)).isoformat(),
    }
    base.update(kw)
    return Case(**base)


def make_cases(n: int, seed: int = 12) -> list[Case]:
    """A deterministic, deliberately messy corpus: unreadable/empty/future creation
    times, every status/verdict/decider, multi-valued and case-variant rules, valid and
    forged ATT&CK ids, human and agent lifecycle transitions, graded feedback and
    explicit classifications, analyst-policy closes."""
    rng = random.Random(seed)
    statuses = list(CaseStatus)
    verdicts = list(Verdict) + [None]
    deciders = list(DecisionBy) + [None]
    dispositions = list(Disposition) + [None]
    out: list[Case] = []
    for i in range(n):
        if i % 97 == 0:
            created = ""
        elif i % 97 == 1:
            created = "not-a-date"
        elif i % 211 == 3:
            created = (NOW + timedelta(hours=rng.randint(1, 72))).isoformat()
        else:
            created = (NOW - timedelta(seconds=rng.randint(0, 500 * 86_400))).isoformat()
        status = rng.choice(statuses)
        decision_by = rng.choice(deciders)
        created_dt = parse_es_timestamp(created) or NOW
        history_entries: list[StatusHistoryEntry] = []
        if status.value not in ("new", "open") and rng.random() < 0.8:
            by = rng.choice(["analyst-1", "system", "agent", "bob"])
            history_entries.append(StatusHistoryEntry(
                from_status="open", to_status=rng.choice(["investigating", "escalated", "on_hold"]),
                by=by, at=(created_dt + timedelta(minutes=rng.randint(1, 600))).isoformat(),
            ))
        if status.value in _TERMINAL:
            history_entries.append(StatusHistoryEntry(
                from_status="investigating", to_status=status.value,
                by=rng.choice(["agent", "analyst-1"]),
                at=(created_dt + timedelta(minutes=rng.randint(30, 5000))).isoformat(),
            ))
        feedback: list[FeedbackEntry] = []
        history: list[dict[str, Any]] = []
        disposition = rng.choice(dispositions)
        if rng.random() < 0.06:
            feedback.append(FeedbackEntry(
                actual_outcome=rng.choice(["false_positive", "true_positive", "unknown"]),
                ts=(created_dt + timedelta(hours=2)).isoformat(),
            ))
        if rng.random() < 0.06:
            decision_by = DecisionBy.ANALYST
            disposition = rng.choice([Disposition.FALSE_POSITIVE, Disposition.BENIGN,
                                      Disposition.TRUE_POSITIVE])
            history.append({"event": "analyst_action", "action": "set_disposition",
                            "ts": (created_dt + timedelta(hours=3)).isoformat()})
        analyst_policy = None
        if decision_by == DecisionBy.ANALYST_POLICY and rng.random() < 0.5:
            analyst_policy = {"policy_id": "p1"}
        out.append(Case(
            case_id=f"c{i:06d}",
            cluster_signature=f"sig-{i}",
            created_at=created,
            updated_at=created or NOW.isoformat(),
            source_surface=rng.choice(list(SourceSurface)),
            entity=Entity(type=EntityType.IP, value=f"10.0.0.{i % 7}"),
            source_id=rng.choice([None, "src-a", "src-b"]),
            source_name=rng.choice(["", "Wazuh EU", "Elastic"]),
            rule_ids=rng.sample(["r-ssh", "r-web", "R-SSH", "r-dns"], rng.randint(0, 3)),
            mitre=rng.sample(["T1110", "T1059.001", "T1566", "t1078", "T9999", "bogus"],
                             rng.randint(0, 3)),
            risk_score=float(rng.choice([0, 12.5, 35, 50, 72.5, 90, 99])),
            verdict=rng.choice(verdicts),
            status=status,
            disposition=disposition,
            decision_by=decision_by,
            assignee=rng.choice(["", "alice", " Alice ", "bob", "carol "]),
            priority_level=rng.choice([None, "P1", "P2", "P3", "P4"]),
            severity_band=rng.choice([None, None, "critical", "high", "low"]),
            escalation_level=1 if rng.random() < 0.05 else 0,
            status_history=history_entries,
            acknowledged_at=(created_dt + timedelta(minutes=5)) if rng.random() < 0.1 else None,
            first_seen_millis=(
                int(created_dt.timestamp() * 1000) - rng.randint(0, 3600) * 1000
                if rng.random() < 0.7 else 0
            ),
            feedback=feedback,
            history=history,
            analyst_policy=analyst_policy,
            title=f"Case {i}",
            tags=["demo"] if i % 5 == 0 else [],
        ))
    return out


# --------------------------------------------------------------------------- #
# An INDEPENDENT brute-force ground truth (written fresh from the documented
# semantics, deliberately not sharing code with the module under test).
# --------------------------------------------------------------------------- #
def _value(case: Case, name: str, prefs: Any = None) -> list[Any]:
    status = case.status.value
    if name == "verdict":
        return [case.verdict.value if case.verdict else None]
    if name == "status":
        return [status]
    if name == "status_group":
        return ["active" if status in _ACTIVE else "terminal" if status in _TERMINAL else None]
    if name == "severity":
        return [band_of_case(case, prefs)]
    if name == "priority":
        return [case.priority_level or None]
    if name == "rule":
        return list(dict.fromkeys(case.rule_ids)) or [None]
    if name == "assignee":
        return [case.assignee.strip() or None]
    if name == "source":
        return [case.source_id or None]
    if name == "surface":
        return [case.source_surface.value]
    if name == "disposition":
        return [case.disposition.value if case.disposition else None]
    if name in ("mitre_technique", "mitre_tactic"):
        ids: list[str] = []
        tactics: list[str] = []
        for raw in case.mitre:
            meta = mitre_engine.technique(raw)
            if not isinstance(meta, dict):
                continue
            tid = str(meta.get("id") or "").upper()
            if tid and tid not in ids:
                ids.append(tid)
                for tac in meta.get("tactics") or []:
                    if tac not in tactics:
                        tactics.append(tac)
        return (ids if name == "mitre_technique" else tactics) or [None]
    if name == "decided_by":
        return [case.decision_by.value if case.decision_by else None]
    if name == "closed_by":
        if status not in _TERMINAL:
            return [None]
        if is_policy_closed(case):
            return ["analyst_policy"]
        if case.decision_by == DecisionBy.AGENT:
            return ["agent"]
        if case.decision_by == DecisionBy.ANALYST:
            return ["analyst"]
        return ["system"]
    raise AssertionError(name)


def truth(cases: list[Case], window: Any, group_by: tuple[str, ...], unit: str | None,
          keep: Any = None) -> tuple[int, int, dict[tuple, int]]:
    """``(total, missing, {(gkey, bucket_start|MISSING|None): count})`` by brute force.

    Membership is the dashboards' rule: a dated case is in ``[start, end)``; a case with
    no readable creation date is counted only in an all-time window and is otherwise
    disclosed (``missing``) without being counted. A relative window broken down by a
    calendar unit spans whole periods (``align_window``)."""
    if unit:
        window = align_window(window, unit)
    unbounded = window.start is None and window.open_end
    total = missing = 0
    rows: Counter = Counter()
    for case in cases:
        if keep is not None and not keep(case):
            continue
        created = parse_es_timestamp(case.created_at) if case.created_at else None
        if created is not None:
            if window.start is not None and created < window.start:
                continue
            if not window.open_end and created >= window.end:
                continue
        else:
            missing += 1
            if not unbounded:
                continue
        total += 1
        bkey = (MISSING_BUCKET if created is None else period_start(created, unit, window.tz)) \
            if unit else None
        for gkey in set(product(*(_value(case, f) for f in group_by))):
            rows[(gkey, bkey)] += 1
    return total, missing, dict(rows)


def rows_of(result: AggregateResult, group_by: tuple[str, ...]) -> dict[tuple, int]:
    out: dict[tuple, int] = {}
    for row in result.groups:
        if row.get("other"):
            continue
        gkey = tuple(row["key"][f] for f in group_by)
        if result.bucket_unit:
            bkey: Any = (MISSING_BUCKET if row["bucket"] == MISSING_BUCKET
                         else datetime.fromisoformat(row["bucket_start"]))
        else:
            bkey = None
        count = row["metrics"]["count"]
        if count:
            out[(gkey, bkey)] = count
    return out


def assert_matches_truth(result: AggregateResult, cases: list[Case], spec: CaseAggregateSpec,
                         keep: Any = None) -> None:
    total, missing, expected = truth(cases, spec.window, spec.group_by, spec.bucket, keep)
    assert result.exact and not result.partial
    assert result.total == total, (spec, result.method)
    assert result.missing_created == missing, (spec, result.method)
    assert rows_of(result, spec.group_by) == expected, (spec, result.method)


# --------------------------------------------------------------------------- #
# Stores
# --------------------------------------------------------------------------- #
class MemoryRepo(CaseRepository):
    """A third-party repository implementing ONLY the abstract surface: the engine must
    aggregate it exactly through the inherited ``scan_page`` → ``export_page`` fold."""

    def __init__(self, cases: list[Case]) -> None:
        self.cases = {c.case_id: c for c in cases}
        self.export_calls = 0

    async def save(self, case: Case) -> None:
        self.cases[case.case_id] = case

    async def get(self, case_id: str) -> Case | None:
        return self.cases.get(case_id)

    async def find_open_by_signature(self, signature: str) -> Case | None:
        return None

    async def list(self, *, status=None, source_surface=None, entity_value=None, limit=50,
                   offset=0, sort_field="created_at", sort_order="desc"):
        self.export_calls += 1
        rows = sorted(self.cases.values(), key=lambda c: (c.created_at, c.case_id),
                      reverse=sort_order == "desc")
        return rows[offset: offset + limit], len(rows)

    async def list_scans(self, limit: int = 50):
        return [], 0

    async def count_new_scans(self, since_iso: str) -> int:
        return 0


async def es_store(cases: list[Case]) -> CaseStore:
    es = InMemoryESClient()
    for case in cases:
        await es.index_doc(CASES_WRITE_ALIAS, case.model_dump(mode="json"), doc_id=case.case_id)
    return CaseStore(es)


async def sql_store(cases: list[Case]) -> SqlCaseRepository:
    engine = build_async_engine("sqlite+aiosqlite:///:memory:")
    await create_all(engine)
    repo = SqlCaseRepository(engine)
    async with repo._sm() as session:  # bulk seed, mirroring ``save``'s columns
        session.add_all([
            CaseRow(
                case_id=c.case_id, cluster_signature=c.cluster_signature,
                status=c.status.value, source_surface=c.source_surface.value,
                entity_value=_entity_value(c), created_at=_canonical_created_at(c.created_at),
                updated_at=c.updated_at or "", doc=c.model_dump(mode="json"),
            )
            for c in cases
        ])
        await session.commit()
    return repo


# --------------------------------------------------------------------------- #
# 1. Semantics
# --------------------------------------------------------------------------- #
async def test_metrics_agree_with_the_dashboard_definitions() -> None:
    cases = make_cases(600, seed=3)
    store = MemoryRepo(cases)
    window = resolve_window("now-120d", now=NOW)
    spec = CaseAggregateSpec(window=window, metrics=CASE_METRICS)
    result = await aggregate_cases(store, spec)
    # The dashboards' membership: a bounded window holds only cases it can place.
    selected = [c for c in cases
                if parse_es_timestamp(c.created_at) is not None
                and window.contains(parse_es_timestamp(c.created_at))]
    totals = result.totals
    assert totals["count"] == len(selected) == result.total
    assert result.missing_created == sum(
        1 for c in cases if parse_es_timestamp(c.created_at) is None) > 0
    assert result.missing_in_total is False
    quality = M.quality_metrics(selected)
    assert totals["auto_closed"] == quality["auto_closed_cases"]
    assert totals["human_closed"] == quality["human_closed_cases"]
    assert totals["verdicted"] == quality["verdicted_cases"]
    assert totals["false_positives"] == quality["false_positive_cases"]
    assert totals["fp_rate"] == quality["false_positive_rate"]
    assert totals["tp_rate"] == round(quality["true_positive_cases"] / quality["verdicted_cases"], 4)
    # The dashboards' ``analyst_confirmed_fp`` population: policy closes excluded.
    assert totals["analyst_fp"] == quality["analyst_confirmed_fp"] == sum(
        1 for c in selected
        if not is_policy_closed(c) and analyst_confirmed_outcome(c)[0] == "false_positive"
    )
    assert totals["analyst_fp"] > 0
    life = M.lifecycle_intervals(selected)
    for metric, block in (("mtta", "mtta_minutes"), ("mttr", "mttr_minutes"),
                          ("mttd", "mttd_minutes")):
        assert totals[f"{metric}_p50"] == life[block]["p50"]
        assert totals[f"{metric}_p90"] == life[block]["p90"]
        assert totals[f"{metric}_samples"] == life[block]["count"]
    risks = [c.risk_score for c in selected]
    assert totals["mean_risk"] == round(sum(risks) / len(risks), 1)
    # open_now in totals is the window-EXEMPT stock over the whole store.
    assert totals["open_now"] == sum(1 for c in cases if c.status.value in _ACTIVE)
    assert totals["open_now"] > sum(1 for c in selected if c.status.value in _ACTIVE)


async def test_mtta_counts_human_acknowledgement_only() -> None:
    created = NOW - timedelta(hours=10)
    human = _case("h", created_at=created.isoformat(), status=CaseStatus.INVESTIGATING,
                  status_history=[StatusHistoryEntry(to_status="investigating", by="alice",
                                                     at=(created + timedelta(minutes=30)).isoformat())])
    auto = _case("a", created_at=created.isoformat(), status=CaseStatus.ESCALATED,
                 status_history=[StatusHistoryEntry(to_status="escalated", by="system",
                                                    at=(created + timedelta(minutes=1)).isoformat())])
    result = await aggregate_cases(MemoryRepo([human, auto]), CaseAggregateSpec(
        window=resolve_window("all", now=NOW), metrics=("mtta_p50", "mtta_p90"),
    ))
    assert result.totals["mtta_p50"] == 30.0 and result.totals["mtta_samples"] == 1


async def test_every_group_field_maps_to_the_documented_case_field() -> None:
    created = (NOW - timedelta(days=1)).isoformat()
    case = _case(
        "g1", created_at=created, verdict=Verdict.FALSE_POSITIVE, status=CaseStatus.CLOSED,
        decision_by=DecisionBy.AGENT, disposition=Disposition.BENIGN, assignee="  alice ",
        source_id="src-a", source_surface=SourceSurface.AUTOMATED_SCAN,
        rule_ids=["r1", "r2", "r1"], mitre=["T1110", "bogus", "t1110"], priority_level="P2",
        severity_band="high",
    )
    store = MemoryRepo([case])
    window = resolve_window("all", now=NOW)
    expected = {
        "verdict": ["FALSE_POSITIVE"], "status": ["closed"], "status_group": ["terminal"],
        "severity": ["high"], "priority": ["P2"], "rule": ["r1", "r2"], "assignee": ["alice"],
        "source": ["src-a"], "surface": ["automated_scan"], "disposition": ["benign"],
        "mitre_technique": ["T1110"], "decided_by": ["agent"], "closed_by": ["agent"],
    }
    tactics = mitre_engine.technique("T1110")["tactics"]
    expected["mitre_tactic"] = list(tactics)
    assert set(expected) == set(CASE_GROUP_FIELDS)
    for field_name, values in expected.items():
        result = await aggregate_cases(store, CaseAggregateSpec(window=window, group_by=(field_name,)))
        got = sorted(row["key"][field_name] for row in result.groups)
        assert got == sorted(values), field_name
        assert result.total == 1
        assert result.multi_valued == ((field_name,) if field_name in (
            "rule", "mitre_tactic", "mitre_technique") else ())


async def test_closed_by_partition_and_policy_close() -> None:
    cases = [
        _case("p", status=CaseStatus.CLOSED, decision_by=DecisionBy.ANALYST,
              analyst_policy={"policy_id": "x"}),  # erasable decider; durable payload wins
        _case("s", status=CaseStatus.RESOLVED, decision_by=None),
        _case("o", status=CaseStatus.OPEN, decision_by=DecisionBy.AGENT),
    ]
    result = await aggregate_cases(MemoryRepo(cases), CaseAggregateSpec(
        window=resolve_window("all", now=NOW), group_by=("closed_by",),
        metrics=("count", "auto_closed", "human_closed"),
    ))
    by = {row["key"]["closed_by"]: row["metrics"] for row in result.groups}
    assert set(by) == {"analyst_policy", "system", None}
    # A policy close is never agent or human work.
    assert by["analyst_policy"]["human_closed"] == 0 and by["analyst_policy"]["auto_closed"] == 0


@pytest.mark.parametrize(
    "filters, expect_ids",
    [
        ({"status": "open"}, {"a"}),
        ({"status_group": "terminal"}, {"b", "c"}),
        ({"status_group": "closed"}, {"b", "c"}),  # alias
        ({"verdict": "false_positive"}, {"a", "c"}),
        ({"verdict": ["TRUE_POSITIVE", "FALSE_POSITIVE"]}, {"a", "b", "c"}),
        ({"entity": "10.9.9.9"}, {"c"}),
        ({"assignee": "ALICE"}, {"a"}),
        ({"assignee": "unassigned"}, {"b", "c"}),
        ({"rule": "R-WEB"}, {"b"}),
        ({"source": "src-x"}, {"a"}),
        ({"source": "wazuh eu"}, {"b"}),
        ({"surface": "chat"}, {"c"}),
        ({"disposition": "benign"}, {"b"}),
        ({"decided_by": "agent"}, {"c"}),
        ({"closed_by": "agent"}, {"c"}),
        ({"mitre_technique": "t1110"}, {"a"}),
        ({"text": "needle"}, {"b"}),
        ({"severity": "critical"}, {"a"}),
        ({"priority": "p3"}, {"c"}),
        ({"verdict": None, "text": "  "}, {"a", "b", "c"}),  # blank filters are absent
    ],
)
async def test_filters(filters, expect_ids) -> None:
    cases = [
        _case("a", status=CaseStatus.OPEN, verdict=Verdict.FALSE_POSITIVE, assignee=" Alice",
              source_id="src-x", mitre=["T1110"], severity_band="critical"),
        _case("b", status=CaseStatus.RESOLVED, verdict=Verdict.TRUE_POSITIVE, rule_ids=["r-web"],
              source_name="Wazuh EU", disposition=Disposition.BENIGN, title="needle here"),
        _case("c", status=CaseStatus.CLOSED, verdict=Verdict.FALSE_POSITIVE,
              decision_by=DecisionBy.AGENT, source_surface=SourceSurface.CHAT,
              entity=Entity(type=EntityType.IP, value="10.9.9.9"), priority_level="P3"),
    ]
    result = await aggregate_cases(MemoryRepo(cases), CaseAggregateSpec(
        window=resolve_window("all", now=NOW), filters=filters, group_by=("status",),
    ))
    # Each case has a distinct status, so the non-empty status rows name the matches.
    ids = {c.case_id for c in cases if c.status.value in {
        row["key"]["status"] for row in result.groups if row["metrics"]["count"]}}
    assert result.total == len(expect_ids)
    assert ids == expect_ids


@pytest.mark.parametrize(
    "spec_kw",
    [
        {"group_by": ("nope",)},
        {"group_by": ("verdict", "status", "rule")},
        {"group_by": ("verdict", "verdict")},
        {"metrics": ("count", "bogus")},
        {"metrics": ()},
        {"bucket": "fortnight"},
        {"top_n": 0},
        {"filters": {"colour": "red"}},
        {"filters": {"verdict": "MAYBE"}},
        {"filters": {"status": "open", "status_group": "active"}},
        {"filters": {"priority": "P9"}},
    ],
)
async def test_invalid_specs_are_rejected_visibly(spec_kw) -> None:
    spec = CaseAggregateSpec(window=resolve_window("all", now=NOW), **spec_kw)
    with pytest.raises(ValueError):
        await aggregate_cases(MemoryRepo([]), spec)


async def test_absurd_bucket_requests_are_rejected_with_a_coarser_suggestion() -> None:
    year = CaseAggregateSpec(window=resolve_window("now-2y", now=NOW), bucket="hour")
    with pytest.raises(ValueError, match="use week buckets"):
        await aggregate_cases(MemoryRepo([]), year)
    # All time is checked once the oldest record is known.
    old = [_case("old", created_at=(NOW - timedelta(days=900)).isoformat())]
    with pytest.raises(ValueError, match="too many"):
        await aggregate_cases(MemoryRepo(old), CaseAggregateSpec(
            window=resolve_window("all", now=NOW), bucket="hour"))
    fine = await aggregate_cases(MemoryRepo(old), CaseAggregateSpec(
        window=resolve_window("all", now=NOW), bucket="month"))
    assert fine.total == 1


# --------------------------------------------------------------------------- #
# 2. Honesty
# --------------------------------------------------------------------------- #
async def test_unreadable_creation_time_is_disclosed_never_dropped() -> None:
    """The dashboards' membership rule: a bounded window cannot place a case without a
    readable creation date, so it is DISCLOSED (``missing_created``), not counted; all
    time counts it in its own bucket. Never silently dropped either way."""
    cases = [
        _case("ok", created_at=(NOW - timedelta(days=2)).isoformat()),
        _case("empty", created_at=""),
        _case("junk", created_at="2026-13-45T99:99:99"),
        _case("old", created_at=(NOW - timedelta(days=400)).isoformat()),
    ]
    window = resolve_window("now-30d", now=NOW)
    result = await aggregate_cases(MemoryRepo(cases), CaseAggregateSpec(window=window, bucket="week"))
    assert result.total == 1 and result.missing_created == 2
    assert result.missing_in_total is False and result.exact
    assert not [r for r in result.groups if r["bucket"] == MISSING_BUCKET]
    assert sum(r["metrics"]["count"] for r in result.groups) == result.total
    # The calendar axis lists only calendar periods, zero-filled across the window.
    assert MISSING_BUCKET not in [label for label, _ in result.buckets]
    assert len(result.buckets) in (5, 6) and result.buckets[-1][1] is True

    lifetime = await aggregate_cases(MemoryRepo(cases), CaseAggregateSpec(
        window=resolve_window("all", now=NOW), bucket="month"))
    assert lifetime.total == 4 and lifetime.missing_created == 2 and lifetime.missing_in_total
    missing_rows = [r for r in lifetime.groups if r["bucket"] == MISSING_BUCKET]
    assert missing_rows and missing_rows[0]["metrics"]["count"] == 2
    dated = sum(r["metrics"]["count"] for r in lifetime.groups if r["bucket"] != MISSING_BUCKET)
    assert dated + lifetime.missing_created == lifetime.total


async def test_top_n_keeps_an_exact_other_remainder() -> None:
    cases = [_case(f"c{i}", assignee=name) for i, name in enumerate(
        ["a"] * 5 + ["b"] * 4 + ["c"] * 3 + ["d"] * 2 + ["e"] + [""] * 2)]
    result = await aggregate_cases(MemoryRepo(cases), CaseAggregateSpec(
        window=resolve_window("all", now=NOW), group_by=("assignee",), top_n=2,
        metrics=("count", "open_now"),
    ))
    named = [(r["key"]["assignee"], r["metrics"]["count"]) for r in result.groups]
    assert named == [("a", 5), ("b", 4), (OTHER_KEY, 8)]
    assert result.groups[-1]["other"] is True
    assert result.other == {"groups": 4, "metrics": {"count": 8, "open_now": 8}}
    assert sum(r["metrics"]["count"] for r in result.groups) == result.total == 17


async def test_open_now_is_a_window_exempt_stock_per_group() -> None:
    cases = [
        _case("new-open", status=CaseStatus.OPEN, assignee="alice"),
        _case("old-open", status=CaseStatus.OPEN, assignee="bob",
              created_at=(NOW - timedelta(days=300)).isoformat()),
        _case("new-closed", status=CaseStatus.CLOSED, assignee="alice"),
    ]
    window = resolve_window("now-7d", now=NOW)
    flat = await aggregate_cases(MemoryRepo(cases), CaseAggregateSpec(
        window=window, group_by=("assignee",), metrics=("count", "open_now")))
    by = {r["key"]["assignee"]: r["metrics"] for r in flat.groups}
    assert by["alice"] == {"count": 2, "open_now": 1}
    assert by["bob"] == {"count": 0, "open_now": 1}  # outside the window, still open now
    assert flat.totals["open_now"] == 2 and flat.total == 2
    bucketed = await aggregate_cases(MemoryRepo(cases), CaseAggregateSpec(
        window=window, bucket="day", metrics=("count", "open_now")))
    assert sum(r["metrics"]["open_now"] for r in bucketed.groups) == 1  # cohort only
    assert bucketed.totals["open_now"] == 2


async def test_open_cases_by_created_month_all_time() -> None:
    """The screenshot question: "open cases month wise" — exact, every month present."""
    cases = [_case(f"m{i}", status=CaseStatus.OPEN,
                   created_at=(NOW - timedelta(days=31 * i)).isoformat()) for i in range(6)]
    cases.append(_case("closed", status=CaseStatus.CLOSED))
    result = await aggregate_cases(MemoryRepo(cases), CaseAggregateSpec(
        window=resolve_window("all", now=NOW), filters={"status_group": "active"},
        bucket="month"))
    assert result.total == 6
    assert sum(r["metrics"]["count"] for r in result.groups) == 6
    assert result.window_label.startswith("all time (since ")
    assert result.buckets[-1][1] is True  # the current month is in progress


class _FlakyRepo(MemoryRepo):
    def __init__(self, cases: list[Case], fail_on_call: int) -> None:
        super().__init__(cases)
        self.fail_on_call = fail_on_call
        self.closed: list[Any] = []

    async def export_page(self, *, limit: int = 1000, cursor: Any = None):
        if self.export_calls + 1 >= self.fail_on_call:
            raise RuntimeError("store went away")
        return await super().export_page(limit=limit, cursor=cursor)


async def test_mid_scan_failure_is_partial_never_exact() -> None:
    repo = _FlakyRepo(make_cases(2500, seed=9), fail_on_call=2)
    result = await aggregate_cases(repo, CaseAggregateSpec(
        window=resolve_window("all", now=NOW), metrics=("count", "fp_rate")))
    assert result.partial is True and result.exact is False
    assert result.scanned == 1000 and result.total <= 1000
    assert result.expected_total == 2500 and "store went away" in (result.error or "")


class ListOnlyStore:
    """Duck-typed: only ``list`` (what the old dashboard page cache needed)."""

    def __init__(self, cases: list[Case]) -> None:
        self.inner = MemoryRepo(cases)

    async def list(self, **kw):
        return await self.inner.list(**kw)


async def test_a_list_only_store_is_still_aggregated_exactly() -> None:
    cases = make_cases(2300, seed=21)
    spec = CaseAggregateSpec(window=resolve_window("now-1y", now=NOW), group_by=("verdict",),
                             bucket="quarter")
    result = await aggregate_cases(ListOnlyStore(cases), spec)
    assert result.method == "fold" and result.scanned == len(cases)
    assert_matches_truth(result, cases, spec)


async def test_first_page_failure_raises() -> None:
    repo = _FlakyRepo(make_cases(10), fail_on_call=1)
    with pytest.raises(RuntimeError):
        await aggregate_cases(repo, CaseAggregateSpec(window=resolve_window("all", now=NOW)))


async def test_progress_and_cancel_between_pages() -> None:
    repo = MemoryRepo(make_cases(2500, seed=4))
    seen: list[tuple[int, Any]] = []

    async def progress(done: int, total: Any) -> None:
        seen.append((done, total))

    result = await aggregate_cases(repo, CaseAggregateSpec(
        window=resolve_window("all", now=NOW), metrics=("count", "mean_risk")),
        progress=progress)
    assert [d for d, _ in seen] == [1000, 2000, 2500]
    assert all(t == 2500 for _, t in seen) and result.total == 2500

    cancel = asyncio.Event()

    async def cancel_after_first(done: int, total: Any) -> None:
        cancel.set()

    with pytest.raises(AggregationCancelled):
        await aggregate_cases(repo, CaseAggregateSpec(
            window=resolve_window("all", now=NOW), metrics=("count", "mean_risk")),
            progress=cancel_after_first, cancel=cancel)


async def test_cancel_releases_the_elasticsearch_snapshot() -> None:
    store = await es_store(make_cases(2500, seed=5))
    cancel = asyncio.Event()

    async def stop(done: int, total: Any) -> None:
        cancel.set()

    with pytest.raises(AggregationCancelled):
        await fold_cases(store, CaseAggregateSpec(
            window=resolve_window("all", now=NOW), metrics=("count", "mean_risk")),
            progress=stop, cancel=cancel)
    assert store._es._state_pits == {}  # the PIT was closed


async def test_elasticsearch_fold_reads_one_point_in_time() -> None:
    store = await es_store(make_cases(300, seed=6))
    result = await fold_cases(store, CaseAggregateSpec(
        window=resolve_window("now-90d", now=NOW), metrics=("count", "mean_risk")))
    assert result.consistency == "point_in_time" and result.exact
    assert store._es._state_pits == {}


# --------------------------------------------------------------------------- #
# 3. Scale + backend parity (≥ 12,000 cases)
# --------------------------------------------------------------------------- #
N_LARGE = 12_000


@pytest.fixture(scope="module")
def large_cases() -> list[Case]:
    return make_cases(N_LARGE, seed=2026)


# Two windows per grouping: all time un-bucketed, and six calendar months in a DST zone
# bucketed by month (every bucket unit and zone kind is covered at small scale above and
# in ``test_round12_time_windows``).
_SCALE_SPECS = [
    (("all", "UTC"), None),
    (("now-6M", "America/New_York"), "month"),
]
_ES_GROUPINGS = [(), ("verdict",), ("status",), ("status_group",), ("surface",),
                 ("decided_by",), ("rule",), ("rule", "status_group")]
_SQL_GROUPINGS = [(), ("verdict",), ("status",), ("status_group",), ("surface",),
                  ("decided_by",), ("disposition",), ("assignee",), ("source",),
                  ("assignee", "verdict")]
# Folds that cover every push-down-capable field of each backend.
_ES_FOLDS = [("rule", "verdict"), ("status_group", "decided_by"), ("surface", "status")]
_SQL_FOLDS = [("assignee", "source"), ("disposition", "verdict"),
              ("status_group", "decided_by"), ("surface", "status")]
# Folds that cover every group field no backend pushes down.
_FOLD_ONLY = [("severity", "priority"), ("mitre_tactic", "closed_by"),
              ("mitre_technique", "status_group")]


async def _assert_pushdown_and_fold_equal_truth(store, cases, groupings, folds) -> None:
    open_stock = sum(1 for c in cases if c.status.value in _ACTIVE)
    for ((wspec, tz), bucket), group_by in product(_SCALE_SPECS, groupings):
        spec = CaseAggregateSpec(window=resolve_window(wspec, tz=tz, now=NOW),
                                 group_by=group_by, bucket=bucket, metrics=("count", "open_now"))
        result = await aggregate_cases(store, spec)
        assert result.method == "pushdown", spec
        assert_matches_truth(result, cases, spec)
        assert result.totals["open_now"] == open_stock
    for group_by in folds:
        spec = CaseAggregateSpec(window=resolve_window("now-6M", tz="America/New_York", now=NOW),
                                 group_by=group_by, bucket="month", metrics=("count", "open_now"))
        folded = await fold_cases(store, spec)
        assert folded.method == "fold"
        assert_matches_truth(folded, cases, spec)
        pushed = await aggregate_cases(store, spec)
        assert pushed.method == "pushdown"
        # Push-down == fold for the same grouping, row for row.
        assert pushed.groups == folded.groups and pushed.totals == folded.totals
        assert (pushed.total, pushed.missing_created, pushed.buckets) == (
            folded.total, folded.missing_created, folded.buckets)


async def test_es_pushdown_and_fold_equal_ground_truth_at_scale(large_cases) -> None:
    store = await es_store(large_cases)
    await _assert_pushdown_and_fold_equal_truth(store, large_cases, _ES_GROUPINGS, _ES_FOLDS)


async def test_sql_pushdown_and_fold_equal_ground_truth_at_scale(large_cases) -> None:
    store = await sql_store(large_cases)
    await _assert_pushdown_and_fold_equal_truth(store, large_cases, _SQL_GROUPINGS, _SQL_FOLDS)
    # The SQL push-down also answers filtered, day/quarter-bucketed specs exactly.
    active = CaseAggregateSpec(window=resolve_window("now-90d", now=NOW), group_by=("verdict",),
                               bucket="quarter", filters={"status_group": "active"})
    result = await aggregate_cases(store, active)
    assert result.method == "pushdown"
    assert_matches_truth(result, large_cases, active, keep=lambda c: c.status.value in _ACTIVE)


async def test_third_party_repository_fold_equals_ground_truth_at_scale(large_cases) -> None:
    store = MemoryRepo(large_cases)
    spec = CaseAggregateSpec(window=resolve_window("all", now=NOW), group_by=("rule", "verdict"),
                             bucket="quarter", metrics=("count", "open_now"))
    result = await aggregate_cases(store, spec)
    assert result.method == "fold" and result.consistency == "bounded_at_start"
    assert_matches_truth(result, large_cases, spec)
    assert result.scanned == N_LARGE


async def test_fold_only_group_fields_equal_ground_truth() -> None:
    cases = make_cases(3000, seed=77)
    store = MemoryRepo(cases)
    covered: set[str] = set()
    for group_by in _FOLD_ONLY:
        spec = CaseAggregateSpec(window=resolve_window("now-6M", tz="Asia/Kolkata", now=NOW),
                                 group_by=group_by, bucket="week")
        result = await aggregate_cases(store, spec)
        assert result.method == "fold"
        assert_matches_truth(result, cases, spec)
        covered.update(group_by)
    pushable = {f for g in _ES_GROUPINGS + _SQL_GROUPINGS for f in g}
    assert covered | pushable == set(CASE_GROUP_FIELDS)


async def test_pushdown_declines_what_it_cannot_answer_exactly(large_cases) -> None:
    store = await es_store(large_cases[:500])
    for spec_kw in ({"metrics": ("count", "fp_rate")}, {"group_by": ("severity",)},
                    {"group_by": ("assignee",)}, {"filters": {"rule": "r-ssh"}},
                    {"filters": {"text": "case"}}):
        spec = CaseAggregateSpec(window=resolve_window("all", now=NOW), **spec_kw)
        assert await store.aggregate(spec) is None
        assert (await aggregate_cases(store, spec)).method == "fold"
    sql = await sql_store(large_cases[:500])
    # A half-hour zone cannot fold UTC hours into local days exactly: fold instead.
    kolkata = CaseAggregateSpec(window=resolve_window("now-90d", tz="Asia/Kolkata", now=NOW),
                                bucket="day")
    assert await sql.aggregate(kolkata) is None
    assert (await sql.aggregate(CaseAggregateSpec(
        window=resolve_window("all", now=NOW), group_by=("rule",)))) is None


async def test_sql_pushdown_declines_on_a_legacy_non_canonical_timestamp() -> None:
    cases = make_cases(50, seed=1)
    store = await sql_store(cases)
    async with store._sm() as session:
        row = await session.get(CaseRow, cases[5].case_id)
        row.created_at = "2026-03-01T10:00:00Z"  # legacy spelling only the fold can place
        await session.commit()
    spec = CaseAggregateSpec(window=resolve_window("now-1y", now=NOW), bucket="month")
    assert await store.aggregate(spec) is None
    result = await aggregate_cases(store, spec)
    assert result.method == "fold"


async def test_sql_pushdown_declines_on_a_legacy_iso_shaped_unreadable_value() -> None:
    cases = make_cases(40, seed=2)
    store = await sql_store(cases)
    async with store._sm() as session:
        row = await session.get(CaseRow, cases[7].case_id)
        row.created_at = "2026-13-45T99:99:99+00:00"  # canonical-looking, unreadable
        await session.commit()
    spec = CaseAggregateSpec(window=resolve_window("all", now=NOW), bucket="month")
    assert await store.aggregate(spec) is None  # declined, not an error
    assert (await aggregate_cases(store, spec)).method == "fold"


async def test_sql_keyset_scan_pages_in_creation_order_with_never_drop() -> None:
    cases = make_cases(2300, seed=8)
    store = await sql_store(cases)
    lo = NOW - timedelta(days=30)
    seen: list[str] = []
    cursor = None
    pages = 0
    while True:
        rows, cursor, total, consistency = await store.scan_page(
            limit=500, cursor=cursor, created_from=lo)
        pages += 1
        seen.extend(c.case_id for c in rows)
        if cursor is None:
            break
    assert consistency == "bounded_at_start" and len(seen) == len(set(seen)) == total
    expected = {c.case_id for c in cases
                if parse_es_timestamp(c.created_at) is None
                or parse_es_timestamp(c.created_at) >= lo}
    assert set(seen) == expected
    assert pages == total // 500 + 1
