"""Round 12 (WP-AGG): ``aggregate_usage`` over the cost/token ledger (#6).

The ledger is the one record of every model call, so "AI spend by month / by model /
by role" must be exact over every row. Proven three ways against an independent brute
force: the fold over ``export_page`` (any repository), the SQLite ``GROUP BY`` + ``SUM``
push-down, and the Elasticsearch composite + ``sum`` push-down (exercised against a fake
that computes ``sum``; the stock fake does not, so it folds).
"""

from __future__ import annotations

import random
from collections import defaultdict
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from typing import Any, AsyncIterator

import pytest

import app.es.fake as fake_module
from app.engine.case_aggregate import (
    MISSING_USAGE_BUCKET,
    OTHER_KEY,
    UsageAggregateSpec,
    aggregate_usage,
    fold_usage,
)
from app.engine.time_windows import align_window, period_start, resolve_window
from app.es.fake import InMemoryESClient
from app.llm.pricing import provider_for
from app.models import UsageDoc
from app.stores.base import UsageRepository
from app.stores.sql import build_async_engine, create_all
from app.stores.sql.models import UsageRow
from app.stores.sql.repositories import SqlUsageRepository
from app.stores.usage import UsageStore
from app.utils import parse_es_timestamp

UTC = timezone.utc
NOW = datetime.now(UTC).replace(microsecond=0)
MODELS = ["claude-sonnet-4-5", "gpt-5.6-luna", "mock-model", "custom-local"]
ROLES = ["router", "investigator", "chat", "formatter"]


def make_rows(n: int, seed: int = 5) -> list[dict[str, Any]]:
    rng = random.Random(seed)
    rows = []
    for i in range(n):
        ts = (NOW - timedelta(minutes=rng.randint(0, 200 * 24 * 60))).isoformat()
        if i % 101 == 0:
            ts = ""
        rows.append(UsageDoc(
            ts=ts or NOW.isoformat(), role=rng.choice(ROLES), model=rng.choice(MODELS),
            surface=rng.choice(["investigate", "chat", "standup"]),
            case_id=rng.choice([None, "case-1", "case-2"]),
            prompt_tokens=rng.randint(0, 5000), completion_tokens=rng.randint(0, 900),
            cost=round(rng.randint(0, 40000) / 10000.0, 4),
            processing_tier=rng.choice(["standard", "flex", "batch", "", "weird"]),
        ).model_dump(mode="json") | ({"ts": ""} if not ts else {}))
        rows[-1]["total_tokens"] = rows[-1]["prompt_tokens"] + rows[-1]["completion_tokens"]
    return rows


def _group(row: dict[str, Any], name: str) -> Any:
    if name == "provider":
        return provider_for(str(row.get("model") or ""))
    if name == "service_tier":
        tier = str(row.get("processing_tier") or "").strip().lower()
        return tier if tier in ("standard", "flex", "batch") else "unconfirmed"
    return row.get(name) or None


def truth(rows, window, group_by, unit) -> dict[tuple, dict[str, Any]]:
    """By brute force, with the cases' membership rule: a row without a readable ``ts``
    counts only in an all-time window; a bucketed relative window spans whole periods."""
    if unit:
        window = align_window(window, unit)
    unbounded = window.start is None and window.open_end
    out: dict[tuple, dict[str, Any]] = defaultdict(lambda: {"calls": 0, "cost": 0.0, "tok": 0, "in": 0, "out": 0})
    for row in rows:
        ts = parse_es_timestamp(row.get("ts")) if row.get("ts") else None
        if ts is not None and not window.contains(ts):
            continue
        if ts is None and not unbounded:
            continue
        bkey = (MISSING_USAGE_BUCKET if ts is None else period_start(ts, unit, window.tz)) if unit else None
        key = (tuple(_group(row, f) for f in group_by), bkey)
        cell = out[key]
        cell["calls"] += 1
        cell["cost"] += row["cost"]
        cell["tok"] += row["total_tokens"]
        cell["in"] += row["prompt_tokens"]
        cell["out"] += row["completion_tokens"]
    return dict(out)


def assert_matches(result, rows, spec) -> None:
    expected = truth(rows, spec.window, spec.group_by, spec.bucket)
    got: dict[tuple, dict[str, Any]] = {}
    for g in result.groups:
        if g.get("other"):
            continue
        m = g["metrics"]
        if not m.get("calls"):
            continue
        bkey = None
        if result.bucket_unit:
            bkey = (MISSING_USAGE_BUCKET if g["bucket"] == MISSING_USAGE_BUCKET
                    else datetime.fromisoformat(g["bucket_start"]))
        got[(tuple(g["key"][f] for f in spec.group_by), bkey)] = m
    assert set(got) == set(expected), (spec, result.method)
    for key, cell in expected.items():
        m = got[key]
        assert m["calls"] == cell["calls"]
        assert m["total_tokens"] == cell["tok"]
        assert m["input_tokens"] == cell["in"] and m["output_tokens"] == cell["out"]
        assert m["cost_usd"] == pytest.approx(round(cell["cost"], 6), abs=1e-6)
    assert result.total == sum(c["calls"] for c in expected.values())
    assert result.exact


SPECS = [
    ((), None), (("model",), None), (("role", "provider"), None), (("service_tier",), "month"),
    (("surface",), "week"), ((), "day"),
]
METRICS = ("calls", "input_tokens", "output_tokens", "total_tokens", "cost_usd")


class LegacyUsageRepo(UsageRepository):
    """Only the abstract surface + bounded ``records``: one ``unverified`` page."""

    def __init__(self, rows):
        self.rows = rows

    async def write(self, doc):
        return None

    async def summary(self, window_hours: int = 24, case_id=None):
        return {}

    async def records(self, *, limit: int = 1000):
        return list(reversed(self.rows))[:limit]


class PagedUsageRepo(LegacyUsageRepo):
    async def export_page(self, *, limit: int = 1000, cursor: Any = None):
        offset = int(cursor or 0)
        page = self.rows[offset: offset + limit]
        nxt = offset + len(page) if offset + len(page) < len(self.rows) else None
        return page, nxt, len(self.rows), "bounded_at_start"


@pytest.fixture(scope="module")
def rows() -> list[dict[str, Any]]:
    return make_rows(2600)


@pytest.mark.parametrize("group_by, bucket", SPECS)
@pytest.mark.parametrize("tz", ["UTC", "America/New_York"])
async def test_fold_equals_brute_force(rows, group_by, bucket, tz) -> None:
    spec = UsageAggregateSpec(window=resolve_window("now-90d", tz=tz, now=NOW),
                              group_by=group_by, bucket=bucket, metrics=METRICS)
    result = await aggregate_usage(PagedUsageRepo(rows), spec)
    assert result.method == "fold" and result.scanned == len(rows)
    assert_matches(result, rows, spec)


@asynccontextmanager
async def _sql_repo(rows) -> AsyncIterator[SqlUsageRepository]:
    """An in-memory SQLite ledger holding ``rows``. The engine is disposed on exit: an
    engine left to the garbage collector let its aiosqlite worker thread answer after
    the test's event loop had closed ("Event loop is closed" in a later test)."""
    engine = build_async_engine("sqlite+aiosqlite:///:memory:")
    try:
        await create_all(engine)
        repo = SqlUsageRepository(engine)
        async with repo._sm() as session:
            session.add_all([UsageRow(ts=r["ts"], case_id=r.get("case_id"), surface=r["surface"],
                                      role=r["role"], model=r["model"], cost=r["cost"],
                                      total_tokens=r["total_tokens"], doc=r) for r in rows])
            await session.commit()
        yield repo
    finally:
        await engine.dispose()


@pytest.mark.parametrize("group_by, bucket", SPECS)
async def test_sql_pushdown_equals_brute_force(rows, group_by, bucket) -> None:
    async with _sql_repo(rows) as repo:
        for wspec in ("all", "now-90d"):
            spec = UsageAggregateSpec(window=resolve_window(wspec, tz="America/New_York", now=NOW),
                                      group_by=group_by, bucket=bucket, metrics=METRICS)
            result = await aggregate_usage(repo, spec)
            assert result.method == "pushdown"
            assert_matches(result, rows, spec)
            folded = await fold_usage(repo, spec)
            assert folded.method == "fold"
            assert_matches(folded, rows, spec)


async def test_sql_pushdown_declines_derived_filters(rows) -> None:
    async with _sql_repo(rows[:300]) as repo:
        spec = UsageAggregateSpec(window=resolve_window("all", now=NOW), filters={"provider": "openai"})
        assert await repo.aggregate_usage(spec) is None
        result = await aggregate_usage(repo, spec)
    assert result.method == "fold"
    assert result.total == sum(1 for r in rows[:300] if provider_for(r["model"]) == "openai")


async def _es_store(rows) -> UsageStore:
    es = InMemoryESClient()
    for i, row in enumerate(rows):
        await es.index_doc("tlsoc-agent-usage", row, doc_id=f"u{i:05d}")
    return UsageStore(es)


async def test_es_pushdown_folds_on_a_backend_without_sum(rows) -> None:
    store = await _es_store(rows[:400])
    spec = UsageAggregateSpec(window=resolve_window("all", now=NOW), group_by=("model",),
                              metrics=METRICS)
    assert await store.aggregate_usage(spec) is None
    result = await aggregate_usage(store, spec)
    assert result.method == "fold" and result.consistency == "point_in_time"
    assert_matches(result, rows[:400], spec)
    assert result.total == 400


@pytest.fixture
def summing_fake(monkeypatch):
    """A fake whose aggregation engine also computes ``sum`` (real Elasticsearch does)."""
    original = fake_module._aggregate

    def with_sums(aggs, sources):
        out = original({k: v for k, v in aggs.items() if "sum" not in v}, sources)
        for name, body in aggs.items():
            if "sum" in body:
                field = body["sum"]["field"]
                out[name] = {"value": float(sum(float(s.get(field) or 0) for s in sources))}
        return out

    monkeypatch.setattr(fake_module, "_aggregate", with_sums)


@pytest.mark.parametrize("group_by, bucket", SPECS)
async def test_es_pushdown_equals_brute_force(rows, group_by, bucket, summing_fake) -> None:
    store = await _es_store(rows)
    spec = UsageAggregateSpec(window=resolve_window("now-90d", tz="Asia/Kolkata", now=NOW),
                              group_by=group_by, bucket=bucket, metrics=METRICS,
                              filters={"surface": ["chat", "investigate"]})
    result = await aggregate_usage(store, spec)
    assert result.method == "pushdown"
    filtered = [r for r in rows if r["surface"] in ("chat", "investigate")]
    assert_matches(result, filtered, spec)


async def test_missing_timestamp_is_disclosed_never_dropped(rows) -> None:
    """A bounded window discloses rows it cannot place; all time counts them."""
    missing = sum(1 for r in rows if not r["ts"])
    spec = UsageAggregateSpec(window=resolve_window("now-30d", now=NOW), bucket="week",
                              metrics=METRICS)
    result = await aggregate_usage(PagedUsageRepo(rows), spec)
    assert missing and result.missing_created == missing and not result.missing_in_total
    assert not any(g["bucket"] == MISSING_USAGE_BUCKET for g in result.groups)
    lifetime = await aggregate_usage(PagedUsageRepo(rows), UsageAggregateSpec(
        window=resolve_window("all", now=NOW), bucket="month", metrics=METRICS))
    assert lifetime.missing_created == missing and lifetime.missing_in_total
    assert any(g["bucket"] == MISSING_USAGE_BUCKET and g["metrics"]["calls"] == missing
               for g in lifetime.groups)
    assert lifetime.total == len(rows)


async def test_legacy_single_page_repository_is_never_exact(rows) -> None:
    result = await aggregate_usage(LegacyUsageRepo(rows), UsageAggregateSpec(
        window=resolve_window("all", now=NOW)))
    assert result.exact is False and result.consistency == "unverified"
    assert result.scanned == 1000  # the one bounded page it could return


async def test_top_n_ranks_by_spend_with_an_exact_other(rows) -> None:
    spec = UsageAggregateSpec(window=resolve_window("all", now=NOW), group_by=("model",),
                              metrics=METRICS, top_n=2)
    result = await aggregate_usage(PagedUsageRepo(rows), spec)
    named = [g for g in result.groups if not g.get("other")]
    other = [g for g in result.groups if g.get("other")]
    assert len(named) == 2 and len(other) == 1 and other[0]["key"]["model"] == OTHER_KEY
    costs = defaultdict(float)
    for r in rows:
        costs[r["model"]] += r["cost"]
    top = sorted(costs, key=lambda m: -costs[m])[:2]
    assert [g["key"]["model"] for g in named] == top
    assert other[0]["metrics"]["calls"] + sum(g["metrics"]["calls"] for g in named) == len(rows)
    assert result.other["groups"] == len(costs) - 2


async def test_unknown_usage_inputs_are_rejected() -> None:
    for kw in ({"group_by": ("colour",)}, {"metrics": ("bananas",)},
               {"filters": {"colour": "x"}}, {"bucket": "decade"}):
        with pytest.raises(ValueError):
            await aggregate_usage(PagedUsageRepo([]), UsageAggregateSpec(
                window=resolve_window("all", now=NOW), **kw))
