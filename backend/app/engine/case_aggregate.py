"""Exact, full-population case and usage aggregates (Round 12 SPEC §3.5, D8).

INTERFACE STUB written by the orchestrator so WP-AGG (owner) and WP-TOOLS can build in
parallel. WP-AGG replaces the ``NotImplementedError`` bodies; the names, parameters and
dataclass fields are the binding contract (docs/research/2026-10-round12/SPEC.md §3.5).

Strategy: a repository push-down (``CaseRepository.aggregate`` returning a result, or
``None`` when it cannot answer exactly) else a streaming fold over ``export_page`` that
keeps only counters (memory grows with the number of groups, never with the number of
cases). Never samples; never presents a partial count as exact; a case without a
parseable ``created_at`` is counted in ``missing_created`` (own bucket), never dropped
(#4). Aggregates only: nothing here returns case documents (#7).
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

from .time_windows import BucketUnit, ResolvedWindow

CASE_GROUP_FIELDS: tuple[str, ...] = (
    "verdict", "status", "status_group", "severity", "priority", "rule", "assignee", "source",
    "surface", "disposition", "mitre_tactic", "mitre_technique", "decided_by", "closed_by",
)
CASE_METRICS: tuple[str, ...] = (
    "count", "auto_closed", "human_closed", "fp_rate", "tp_rate", "analyst_fp",
    "mtta_p50", "mtta_p90", "mttr_p50", "mttr_p90", "mttd_p50", "mttd_p90", "mean_risk", "open_now",
)
USAGE_GROUP_FIELDS: tuple[str, ...] = ("role", "model", "surface", "provider", "service_tier")
USAGE_METRICS: tuple[str, ...] = ("calls", "input_tokens", "output_tokens", "total_tokens", "cost_usd")

ProgressFn = Callable[[int, "int | None"], Awaitable[None]]


@dataclass(frozen=True)
class CaseAggregateSpec:
    window: ResolvedWindow
    filters: dict[str, Any] = field(default_factory=dict)  # search_cases filters incl. status_group
    group_by: tuple[str, ...] = ()  # <= 2 of CASE_GROUP_FIELDS
    bucket: BucketUnit | None = None  # calendar bucket over created_at
    metrics: tuple[str, ...] = ("count",)  # subset of CASE_METRICS
    top_n: int | None = None  # keep the top N groups by count, plus an exact "Other" remainder


@dataclass
class AggregateResult:
    total: int
    groups: list[dict[str, Any]]  # {"key": {field: value}, "bucket": label | None, "metrics": {...}}
    buckets: list[tuple[str, bool]]  # (label, in_progress), ordered and zero-filled
    exact: bool
    consistency: str  # "point_in_time" | "bounded_at_start" | "unverified"
    scanned: int
    missing_created: int = 0
    other: dict[str, Any] | None = None  # the exact remainder when top_n trimmed groups
    totals: dict[str, Any] = field(default_factory=dict)  # metrics over the whole selection


@dataclass(frozen=True)
class UsageAggregateSpec:
    window: ResolvedWindow
    filters: dict[str, Any] = field(default_factory=dict)
    group_by: tuple[str, ...] = ()  # <= 2 of USAGE_GROUP_FIELDS
    bucket: BucketUnit | None = None
    metrics: tuple[str, ...] = ("calls", "total_tokens", "cost_usd")


async def aggregate_cases(
    store: Any,
    spec: CaseAggregateSpec,
    *,
    progress: ProgressFn | None = None,
    cancel: asyncio.Event | None = None,
) -> AggregateResult:
    raise NotImplementedError("WP-AGG implements aggregate_cases")


async def aggregate_usage(
    store: Any,
    spec: UsageAggregateSpec,
    *,
    progress: ProgressFn | None = None,
    cancel: asyncio.Event | None = None,
) -> AggregateResult:
    raise NotImplementedError("WP-AGG implements aggregate_usage")
