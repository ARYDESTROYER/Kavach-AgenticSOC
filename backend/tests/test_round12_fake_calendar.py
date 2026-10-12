"""Round 12 (WP-AGG): the in-memory Elasticsearch fake buckets calendar intervals.

Diagnosis E8: ``calendar_interval: "1M"`` parsed as ONE HOUR and ``"month"``/``"week"``
fell back to one-hour buckets, so every monthly/weekly chart on the in-memory backend
(Demo Mode, key-less installs) was silently hourly. The fake now buckets whole calendar
periods in ``time_zone`` (ISO weeks start on Monday) and implements the ``composite``
aggregation the exact-aggregate push-down pages through.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app.engine.time_windows import period_start
from app.es.fake import InMemoryESClient

UTC = timezone.utc
INDEX = "tlsoc-test-*"


def _ms(dt: datetime) -> int:
    return int(dt.timestamp() * 1000)


async def _seed(es: InMemoryESClient, stamps: list[datetime], **extra) -> None:
    for i, stamp in enumerate(stamps):
        doc = {"ts": stamp.isoformat(), "n": i}
        doc.update({k: (v(i) if callable(v) else v) for k, v in extra.items()})
        await es.index_doc("tlsoc-test-000001", doc, doc_id=f"d{i:04d}")


@pytest.mark.parametrize("interval, unit", [
    ("month", "month"), ("1M", "month"), ("week", "week"), ("1w", "week"),
    ("quarter", "quarter"), ("1q", "quarter"), ("year", "year"), ("1y", "year"),
    ("day", "day"), ("1d", "day"), ("hour", "hour"), ("1h", "hour"),
])
@pytest.mark.parametrize("tz", ["UTC", "America/New_York", "Asia/Kolkata"])
async def test_calendar_date_histogram_buckets_whole_periods(interval, unit, tz) -> None:
    es = InMemoryESClient()
    base = datetime(2026, 1, 1, tzinfo=UTC)
    stamps = [base + timedelta(hours=37 * i) for i in range(300)]  # ~15 months
    await _seed(es, stamps)
    resp = await es.search(INDEX, {"size": 0, "aggs": {"h": {"date_histogram": {
        "field": "ts", "calendar_interval": interval, "time_zone": tz}}}})
    buckets = resp["aggregations"]["h"]["buckets"]
    expected: dict[int, int] = {}
    for stamp in stamps:
        key = _ms(period_start(stamp, unit, tz))
        expected[key] = expected.get(key, 0) + 1
    assert {b["key"]: b["doc_count"] for b in buckets} == expected
    assert sum(b["doc_count"] for b in buckets) == len(stamps)


async def test_month_buckets_are_not_hours_anymore() -> None:
    es = InMemoryESClient()
    await _seed(es, [datetime(2026, 3, d, h, tzinfo=UTC) for d in (2, 15, 28) for h in (1, 13)])
    resp = await es.search(INDEX, {"size": 0, "aggs": {"m": {"date_histogram": {
        "field": "ts", "calendar_interval": "1M"}}}})
    assert resp["aggregations"]["m"]["buckets"] == [
        {"key": _ms(datetime(2026, 3, 1, tzinfo=UTC)), "doc_count": 6}
    ]


@pytest.mark.parametrize("fixed, width_ms", [("1h", 3_600_000), ("30m", 1_800_000),
                                              ("1d", 86_400_000), ("90s", 90_000)])
async def test_fixed_intervals_keep_fixed_width_arithmetic(fixed, width_ms) -> None:
    es = InMemoryESClient()
    stamps = [datetime(2026, 5, 1, tzinfo=UTC) + timedelta(minutes=17 * i) for i in range(40)]
    await _seed(es, stamps)
    resp = await es.search(INDEX, {"size": 0, "aggs": {"f": {"date_histogram": {
        "field": "ts", "fixed_interval": fixed}}}})
    keys = {b["key"] for b in resp["aggregations"]["f"]["buckets"]}
    assert keys == {(_ms(s) // width_ms) * width_ms for s in stamps}


async def test_composite_terms_and_histogram_with_missing_buckets_and_paging() -> None:
    es = InMemoryESClient()
    stamps = [datetime(2026, 1, 1, tzinfo=UTC) + timedelta(days=11 * i) for i in range(60)]
    await _seed(
        es, stamps,
        status=lambda i: ["open", "closed", None][i % 3],
        rules=lambda i: [["a", "b"], ["a"], [], ["b", "b"]][i % 4],
    )
    # One doc with an unreadable time and one with none at all.
    await es.index_doc("tlsoc-test-000001", {"ts": "garbage", "status": "open", "rules": ["a"]},
                       doc_id="bad")
    await es.index_doc("tlsoc-test-000001", {"status": "open", "rules": ["a"]}, doc_id="none")
    sources = [
        {"s": {"terms": {"field": "status", "missing_bucket": True}}},
        {"r": {"terms": {"field": "rules", "missing_bucket": True}}},
        {"m": {"date_histogram": {"field": "ts", "calendar_interval": "month",
                                  "missing_bucket": True}}},
    ]
    seen: list[tuple] = []
    after = None
    pages = 0
    while True:
        comp = {"size": 7, "sources": sources}
        if after:
            comp["after"] = after
        resp = await es.search(INDEX, {"size": 0, "aggs": {"g": {"composite": comp}}})
        agg = resp["aggregations"]["g"]
        pages += 1
        if not agg["buckets"]:
            assert "after_key" not in agg
            break
        assert agg["after_key"] == agg["buckets"][-1]["key"]
        seen.extend((tuple(b["key"].values()), b["doc_count"]) for b in agg["buckets"])
        after = agg["after_key"]
    keys = [k for k, _ in seen]
    assert len(keys) == len(set(keys))  # each combination exactly once across pages
    assert pages > 3
    # Brute force: one bucket per distinct (status, rule, month) a doc produces.
    expected: dict[tuple, int] = {}
    docs = [(stamps[i], ["open", "closed", None][i % 3], [["a", "b"], ["a"], [], ["b", "b"]][i % 4])
            for i in range(60)]
    docs += [(None, "open", ["a"]), (None, "open", ["a"])]
    for stamp, status, rules in docs:
        month = _ms(period_start(stamp, "month")) if stamp else None
        for rule in (sorted(set(rules)) or [None]):
            key = (status, rule, month)
            expected[key] = expected.get(key, 0) + 1
    assert dict(seen) == expected


async def test_composite_without_missing_bucket_skips_documents() -> None:
    es = InMemoryESClient()
    await _seed(es, [datetime(2026, 1, 1, tzinfo=UTC)] * 3, status=lambda i: None if i else "x")
    resp = await es.search(INDEX, {"size": 0, "aggs": {"g": {"composite": {
        "sources": [{"s": {"terms": {"field": "status"}}}]}}}})
    assert resp["aggregations"]["g"]["buckets"] == [{"key": {"s": "x"}, "doc_count": 1}]


async def test_metric_aggregations_stay_unsupported_so_callers_fall_back() -> None:
    """``stores/usage`` detects a backend that cannot ``sum`` and scans instead — the
    fake must keep NOT computing metric aggregations."""
    es = InMemoryESClient()
    await _seed(es, [datetime(2026, 1, 1, tzinfo=UTC)], cost=1.5)
    resp = await es.search(INDEX, {"size": 0, "aggs": {"c": {"sum": {"field": "cost"}}}})
    assert "c" not in resp.get("aggregations", {})
