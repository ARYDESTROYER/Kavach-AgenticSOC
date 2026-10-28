"""Round 14 (SPEC §4.4.2): ``GET /api/metrics/breakdown`` and the named metric families.

What this pins:

* **Families.** ``verdicted = verdict_tp + verdict_fp + verdict_needs_human`` (the AI
  verdict family, analyst-policy closes excluded) and ``count = analyst_tp + analyst_fp +
  analyst_ungraded`` (the analyst outcome family, policy closes never graded), on every
  row, in the engine and on the wire.
* **Parity with chat.** For every ``by`` and every new metric the endpoint returns the
  numbers the chat's ``case_stats`` returns for the same question (same engine, same
  window resolution, same operator timezone, same prefs): on a hand-built corpus, on the
  Demo dataset and on a 30,000-case fixture.
* **Honesty.** Multi-valued rule rows, the exact "Other" remainder past ``top``, ``then``
  cross-tabs, zero-filled buckets, ``status_group`` (the open stock), the exact
  ``filter_rule``, partial reads (lower bounds, said so), a store that cannot be read at
  all (503, never a zero).
* **Boundaries.** ``400 breakdown_bad_param``, ``403`` without the grant (``cost:view``
  for ``kind=usage``), ``409 breakdown_scope_unsupported`` under row-level scope, the Demo
  store while Demo Mode is on, no model call (#6) and no audit row (a read).
"""

from __future__ import annotations

import asyncio
import json
import random
import re
from collections import Counter
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from typing import Any

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient
from httpx import ASGITransport, AsyncClient

from app.agents.chat_tools.stats import CaseStatsTool, group_label
from app.api import routes_metrics
from app.api.deps import require_auth
from app.api.routes_metrics import BREAKDOWN_SPEC_METRICS, invalidate_breakdown_cache
from app.api.routes_metrics import router as metrics_router
from app.constants import (
    OPEN_CASE_STATUSES,
    TERMINAL_CASE_STATUSES,
    CaseStatus,
    DecisionBy,
    Disposition,
    EntityType,
    SourceSurface,
    Verdict,
)
from app.engine import mitre as mitre_engine
from app.engine.analyst_outcomes import analyst_confirmed_outcome
from app.engine.case_aggregate import (
    CASE_METRICS,
    AggregateRequestError,
    BucketBudgetError,
    CaseAggregateSpec,
    _raw_projection,
    aggregate_cases,
    normalise_case_filters,
)
from app.engine.precedent import is_policy_closed
from app.engine.priority import band_of_case
from app.engine.time_windows import resolve_window
from app.models import (
    BREAKDOWN_CASE_FIELDS,
    BREAKDOWN_CASE_METRICS,
    Case,
    Entity,
    FeedbackEntry,
    MetricsBreakdown,
    MetricsBreakdownGroup,
    UsageDoc,
)
from app.stores.base import CaseRepository
from app.utils import parse_es_timestamp
from tests.test_chat_tools_support import make_ctx

UTC = timezone.utc
NOW = datetime.now(UTC).replace(microsecond=0)
_ACTIVE = frozenset(OPEN_CASE_STATUSES)
_TERMINAL = frozenset(TERMINAL_CASE_STATUSES)
NEW_METRICS = ("verdicted", "verdict_tp", "verdict_fp", "verdict_needs_human", "analyst_tp",
               "analyst_ungraded")


@pytest.fixture(autouse=True)
def _fresh_breakdown_cache():
    """Every test reads its own stores (the shared answers are keyed by store identity
    anyway); clearing keeps each test hermetic however fixtures compose."""
    invalidate_breakdown_cache()
    yield
    invalidate_breakdown_cache()


# --------------------------------------------------------------------------- #
# Corpus
# --------------------------------------------------------------------------- #
def _case(cid: str, *, hours_ago: float = 2.0, **kw: Any) -> Case:
    base: dict[str, Any] = {
        "case_id": cid,
        "cluster_signature": f"sig-{cid}",
        "source_surface": SourceSurface.AUTOMATED_SCAN,
        "entity": Entity(type=EntityType.IP, value="10.0.0.1"),
        "created_at": (NOW - timedelta(hours=hours_ago)).isoformat(),
        "title": f"Case {cid}",
    }
    base.update(kw)
    return Case(**base)


def _feedback(outcome: str) -> list[FeedbackEntry]:
    return [FeedbackEntry(actual_outcome=outcome, ts=(NOW - timedelta(hours=1)).isoformat())]


def corpus() -> list[Case]:
    """Seven cases whose every figure is worked out by hand in the tests below. Dated
    cases sit 1 to 30 hours old or 40 days old, far from any day boundary a whole-day
    window could move across while a test runs."""
    return [
        # AI FP, auto-closed, nobody graded it.
        _case("c1", rule_ids=["r-ssh"], verdict=Verdict.FALSE_POSITIVE, status=CaseStatus.CLOSED,
              decision_by=DecisionBy.AGENT, severity_band="high", source_id="src-a",
              assignee="alice"),
        # AI TP, still open (escalated), an analyst confirmed it a true positive.
        _case("c2", rule_ids=["r-ssh", "r-web"], verdict=Verdict.TRUE_POSITIVE,
              status=CaseStatus.ESCALATED, severity_band="critical", source_id="src-a",
              feedback=_feedback("true_positive"), assignee="bob", mitre=["T1110"]),
        # Needs a human, open, unassigned.
        _case("c3", rule_ids=["r-web"], verdict=Verdict.NEEDS_HUMAN, status=CaseStatus.NEEDS_HUMAN,
              severity_band="medium", source_id="src-b"),
        # Declared benign by an analyst rule policy: no model ran, never graded.
        _case("c4", rule_ids=["r-ssh"], verdict=None, status=CaseStatus.CLOSED,
              decision_by=DecisionBy.ANALYST_POLICY, disposition=Disposition.FALSE_POSITIVE,
              analyst_policy={"policy_id": "p1"}, severity_band="low", source_id="src-a",
              feedback=_feedback("false_positive")),
        # A case-variant rule value; AI FP the analyst confirmed false positive.
        _case("c5", hours_ago=30, rule_ids=["R-SSH"], verdict=Verdict.FALSE_POSITIVE,
              status=CaseStatus.RESOLVED, decision_by=DecisionBy.ANALYST, severity_band="high",
              source_id="src-b", feedback=_feedback("false_positive"), assignee="alice"),
        # Open, AI needs human, created 40 days ago: in the open stock, not in "last 7 days".
        _case("c6", hours_ago=40 * 24, rule_ids=["r-ssh"], verdict=Verdict.NEEDS_HUMAN,
              status=CaseStatus.OPEN, severity_band="high", source_id="src-a"),
        # Brand new, no rule, no verdict yet.
        _case("c7", hours_ago=1, rule_ids=[], verdict=None, status=CaseStatus.NEW,
              severity_band="info"),
    ]


# --------------------------------------------------------------------------- #
# Harness
# --------------------------------------------------------------------------- #
def _api(state: Any) -> FastAPI:
    api = FastAPI()
    api.include_router(metrics_router, dependencies=[Depends(require_auth)])
    api.state.tlsoc = state
    return api


async def _get(state: Any, **params: Any) -> Any:
    clean = {k: v for k, v in params.items() if v is not None}
    async with AsyncClient(transport=ASGITransport(app=_api(state)), base_url="http://test") as client:
        return await client.get("/api/metrics/breakdown", params=clean)


async def _breakdown(state: Any, **params: Any) -> dict[str, Any]:
    response = await _get(state, **params)
    assert response.status_code == 200, response.text
    body = response.json()
    MetricsBreakdown.model_validate(body)  # the wire shape is the WP-0 model
    return body


async def _seed(state: Any, cases: list[Case]) -> None:
    for case in cases:
        await state.cases.save(case)


def _rows(body: dict[str, Any]) -> dict[Any, dict[str, Any]]:
    """``{key: group}`` (``(key, then_key)`` with ``then``; ``(key, bucket)`` with buckets)."""
    out: dict[Any, dict[str, Any]] = {}
    for group in body["groups"]:
        if body["then"]:
            out[(group["key"], group["then_key"])] = group
        elif body["bucket"]:
            out[(group["key"], group["bucket"])] = group
        else:
            out[group["key"]] = group
    return out


def _assert_families(group: dict[str, Any]) -> None:
    assert group["verdict_tp"] + group["verdict_fp"] + group["verdict_needs_human"] == group["verdicted"]
    assert group["analyst_tp"] + group["analyst_fp"] + group["analyst_ungraded"] == group["count"]
    assert group["calls"] is None and group["cost_usd"] is None


# --------------------------------------------------------------------------- #
# 1. The families, by hand
# --------------------------------------------------------------------------- #
async def test_rule_rows_are_multi_valued_and_every_row_keeps_both_families(app_state) -> None:
    await _seed(app_state, corpus())
    body = await _breakdown(app_state, by="rule", window="now-7d", top=50)
    assert body["kind"] == "cases" and body["by"] == "rule" and body["multi_valued"] is True
    assert body["exact"] is True and body["partial"] is False and body["partial_reason"] is None
    assert body["total"] == 6                       # c6 is 40 days old
    # A caption start in sentence case (SPEC §4.4.3); the window is chat's own.
    assert body["window_label"].startswith("Last 7 days (since ")
    rows = _rows(body)
    assert set(rows) == {"r-ssh", "r-web", "R-SSH", None}  # the stored values, case kept
    # A case with two rules counts in both rows, so the rows outnumber the cases.
    assert sum(g["count"] for g in body["groups"]) == 7 > body["total"]
    ssh = rows["r-ssh"]                             # c1, c2, c4
    assert (ssh["count"], ssh["verdicted"], ssh["verdict_tp"], ssh["verdict_fp"],
            ssh["verdict_needs_human"]) == (3, 2, 1, 1, 0)
    # c4's analyst_policy close and its false_positive feedback are not ground truth.
    assert (ssh["analyst_tp"], ssh["analyst_fp"], ssh["analyst_ungraded"]) == (1, 0, 2)
    # open_now is the window-exempt stock: c2 and the 40-day-old c6.
    assert ssh["open_now"] == 2
    web = rows["r-web"]                             # c2, c3
    assert (web["count"], web["verdicted"], web["verdict_needs_human"], web["open_now"]) == (2, 2, 1, 2)
    upper = rows["R-SSH"]                           # c5
    assert (upper["verdict_fp"], upper["analyst_fp"], upper["open_now"]) == (1, 1, 0)
    assert rows[None]["count"] == 1                 # c7 has no rule
    for group in body["groups"]:
        _assert_families(group)
    assert body["other"] is None and body["buckets"] == []


async def test_policy_closes_are_never_verdicted_or_graded(app_state) -> None:
    await _seed(app_state, corpus())
    body = await _breakdown(app_state, by="closed_by", window="now-7d")
    policy = _rows(body)["analyst_policy"]
    assert policy["count"] == 1
    assert policy["verdicted"] == 0 and policy["analyst_tp"] == policy["analyst_fp"] == 0
    assert policy["analyst_ungraded"] == 1
    # And the AI verdict family agrees with the legacy fp_rate denominator.
    engine = await aggregate_cases(app_state.cases, CaseAggregateSpec(
        window=resolve_window("now-7d"), metrics=("fp_rate", "verdicted", "verdict_fp"),
    ))
    assert engine.totals["verdicted"] == 4 and engine.totals["false_positives"] == engine.totals["verdict_fp"] == 2


async def test_the_spec_example_identities_hold_on_the_wire(app_state) -> None:
    await _seed(app_state, corpus())
    body = await _breakdown(app_state, by="severity", window="all")
    assert set(body) == {
        "kind", "by", "then", "bucket", "status_group", "window_label", "window_from",
        "window_to", "total", "exact", "partial", "partial_reason", "multi_valued", "groups",
        "buckets", "other", "missing_created", "missing_in_total",
    }
    assert body["multi_valued"] is False and body["window_from"] is None
    # Every case of the corpus is dated: nothing to disclose, and all time would count it.
    assert (body["missing_created"], body["missing_in_total"]) == (0, True)
    assert sum(g["count"] for g in body["groups"]) == body["total"] == 7   # single-valued
    for group in body["groups"]:
        assert set(BREAKDOWN_CASE_METRICS) <= set(group)
        _assert_families(group)
    assert sum(g["analyst_tp"] for g in body["groups"]) == 1   # "Confirmed threats"


async def test_open_stock_by_verdict_counts_needs_human_and_the_unassigned(app_state) -> None:
    """The operations strip's "Awaiting a decision" and "Unassigned" cells."""
    await _seed(app_state, corpus())
    body = await _breakdown(app_state, by="verdict", status_group="open", window="all")
    assert body["status_group"] == "open"
    rows = _rows(body)
    assert rows["NEEDS_HUMAN"]["count"] == 2        # c3 and the 40-day-old c6
    assert rows["TRUE_POSITIVE"]["count"] == 1      # c2
    assert rows[None]["count"] == 1                 # c7
    assert body["total"] == 4
    for group in body["groups"]:
        assert group["count"] == group["open_now"]  # all time + open: the stock itself
    unassigned = _rows(await _breakdown(app_state, by="assignee", status_group="open", window="all", top=50))
    assert unassigned[None]["count"] == 3           # c3, c6 and c7 (c2 is bob's)
    assert unassigned["bob"]["count"] == 1
    closed = await _breakdown(app_state, by="verdict", status_group="closed", window="all")
    assert closed["total"] == 3 and all(g["open_now"] == 0 for g in closed["groups"])


async def test_then_cross_tab_is_exact_and_sums_to_its_first_field(app_state) -> None:
    await _seed(app_state, corpus())
    cross = await _breakdown(app_state, by="severity", then="verdict", window="all", top=50)
    assert cross["then"] == "verdict"
    pairs = {k: g["count"] for k, g in _rows(cross).items() if g["count"]}
    expected = Counter((c.severity_band, c.verdict.value if c.verdict else None) for c in corpus())
    assert pairs == dict(expected)
    single = _rows(await _breakdown(app_state, by="severity", window="all"))
    for severity, group in single.items():
        assert group["count"] == sum(n for (sev, _), n in pairs.items() if sev == severity)


async def test_top_keeps_an_exact_other_remainder_outside_the_groups(app_state) -> None:
    await _seed(app_state, corpus())
    body = await _breakdown(app_state, by="rule", window="now-7d", top=1)
    assert [g["key"] for g in body["groups"]] == ["r-ssh"]
    assert body["other"] == {"count": 4, "groups": 3, "calls": None, "cost_usd": None}


async def test_buckets_are_zero_filled_and_add_up_to_the_unbucketed_rows(app_state) -> None:
    await _seed(app_state, corpus())
    bucketed = await _breakdown(app_state, by="severity", window="now-7d", bucket="day")
    labels = [b["label"] for b in bucketed["buckets"]]
    assert len(labels) == 7 and len(set(labels)) == 7
    assert bucketed["buckets"][-1]["in_progress"] is True
    assert not any(b["in_progress"] for b in bucketed["buckets"][:-1])
    rows = _rows(bucketed)
    flat = _rows(await _breakdown(app_state, by="severity", window="now-7d"))
    for severity, group in flat.items():
        per_day = [rows[(severity, label)]["count"] for label in labels]   # zero-filled
        assert sum(per_day) == group["count"]


async def test_filter_rule_is_exact_and_case_sensitive(app_state) -> None:
    await _seed(app_state, corpus())
    lower = await _breakdown(app_state, by="verdict", window="all", filter_rule="r-ssh")
    upper = await _breakdown(app_state, by="verdict", window="all", filter_rule="R-SSH")
    assert lower["total"] == 4 and upper["total"] == 1        # c1 c2 c4 c6 / c5
    nothing = await _breakdown(app_state, by="verdict", window="all", filter_rule="r-ssh ")
    assert nothing["total"] == 0 and nothing["groups"] == []


async def test_a_blank_rule_value_is_matched_exactly_never_dropped(app_state) -> None:
    """Rule ids are log-derived (#9): a rule of spaces is a real value. Filtering on it
    counts the cases that carry it, never the whole estate as if no filter were set."""
    await _seed(app_state, corpus())
    none = await _breakdown(app_state, by="verdict", window="all", filter_rule="   ")
    assert none["total"] == 0 and none["groups"] == []
    await _seed(app_state, [_case("blank", rule_ids=["   "], verdict=Verdict.NEEDS_HUMAN,
                                  status=CaseStatus.OPEN)])
    invalidate_breakdown_cache()     # the same question within the shared-answer lifetime
    one = await _breakdown(app_state, by="verdict", window="all", filter_rule="   ")
    assert one["total"] == 1 and _rows(one)["NEEDS_HUMAN"]["count"] == 1
    # The rule row of that value is the key a widget sends back.
    keys = {g["key"] for g in (await _breakdown(app_state, by="rule", window="all", top=50))["groups"]}
    assert "   " in keys


def test_the_engine_keeps_a_blank_exact_rule_filter() -> None:
    assert normalise_case_filters({"rule_exact": " "}) == {"rule_exact": [" "]}
    assert normalise_case_filters({"rule_exact": ["", "r-ssh "]}) == {"rule_exact": ["", "r-ssh "]}
    assert normalise_case_filters({"rule_exact": None}) == {}
    # Every other filter still drops blank values (unchanged).
    assert normalise_case_filters({"rule": "  "}) == {}


# --------------------------------------------------------------------------- #
# 2. Usage
# --------------------------------------------------------------------------- #
async def test_usage_breakdown_sums_the_ledger_and_ranks_by_spend(app_state) -> None:
    ts = (NOW - timedelta(hours=3)).isoformat()
    for surface, role, cost in (
        ("investigate", "investigator", 0.5), ("investigate", "router", 0.25),
        ("automated_scan", "investigator", 1.0), ("chat", "chat", 2.0), ("report", "chat", 0.75),
        ("standup", "standup", 0.125),
    ):
        await app_state.usage_store.write_strict(UsageDoc(
            ts=ts, surface=surface, role=role, model="claude-sonnet-4-5", cost=cost,
            prompt_tokens=10, completion_tokens=5, total_tokens=15,
        ))
    body = await _breakdown(app_state, kind="usage", by="surface", window="now-24h")
    assert body["kind"] == "usage" and body["multi_valued"] is False and body["status_group"] is None
    # Ranked by spend, then calls: investigate (2 calls) before report (1) at $0.75 each.
    assert [g["key"] for g in body["groups"]] == ["chat", "automated_scan", "investigate", "report",
                                                  "standup"]
    rows = _rows(body)
    assert rows["investigate"]["calls"] == rows["investigate"]["count"] == 2
    assert rows["investigate"]["cost_usd"] == pytest.approx(0.75)
    assert rows["investigate"]["verdicted"] is None and rows["investigate"]["analyst_tp"] is None
    assert body["total"] == 6
    top = await _breakdown(app_state, kind="usage", by="role", window="now-24h", top=1)
    assert [g["key"] for g in top["groups"]] == ["chat"]
    assert top["other"]["calls"] == 4 and top["other"]["cost_usd"] == pytest.approx(1.875)
    assert top["other"]["groups"] == 3 and top["other"]["count"] == 4
    cross = await _breakdown(app_state, kind="usage", by="role", then="surface", window="now-24h", top=50)
    assert _rows(cross)[("chat", "report")]["cost_usd"] == pytest.approx(0.75)


# --------------------------------------------------------------------------- #
# 3. Refusals
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("params", [
    {"by": "nonsense"},
    {"by": "surface"},                                  # a usage field for kind=cases
    {"by": "rule", "then": "rule"},
    {"by": "rule", "then": "model"},
    {"by": "rule", "kind": "logs"},
    {"by": "rule", "window": "last fortnight-ish"},
    {"by": "rule", "window": "x" * 201},
    {"by": "rule", "bucket": "month"},
    {"by": "rule", "top": 0},
    {"by": "rule", "top": 51},
    {"by": "rule", "status_group": "pending"},
    {"by": "rule", "filter_rule": "r-ssh\nx"},
    {"by": "rule", "filter_rule": "r" * 257},
    {"by": "rule", "filter_rule": ""},                # present but empty: never "no filter"
    # ``top`` is read by the route, so a non-integer is the coded 400 too, never a 422.
    {"by": "rule", "top": "abc"},
    {"by": "rule", "top": "1.5"},
    {"by": "rule", "top": "-1"},
    {"by": "rule", "top": "0"},
    {"by": "rule", "top": "51"},
    {"by": "rule", "top": "\u0663"},                  # a non-ASCII digit
    # More group rows than one answer holds (``top`` times the buckets).
    {"by": "rule", "bucket": "hour", "window": "now-90d", "top": 50},
    {"by": "surface", "kind": "usage", "status_group": "open"},
    {"by": "surface", "kind": "usage", "filter_rule": "r-ssh"},
    {"by": "rule", "kind": "usage"},
    # More buckets than one answer holds (the advice names a unit this endpoint offers).
    {"by": "severity", "bucket": "hour", "window": "2010-01-01..2026-01-01"},
    {"by": "severity", "bucket": "day", "window": "2010-01-01..2026-01-01"},
    {"by": "surface", "kind": "usage", "bucket": "hour", "window": "2010-01-01..2026-01-01"},
])
async def test_bad_parameters_are_a_coded_400(app_state, params: dict[str, Any]) -> None:
    response = await _get(app_state, **params)
    assert response.status_code == 400, response.text
    detail = response.json()["detail"]
    assert detail["code"] == "breakdown_bad_param" and detail["message"]
    assert "—" not in detail["message"]


async def test_by_is_required(app_state) -> None:
    assert (await _get(app_state)).status_code == 422


@pytest.mark.parametrize("failure", ["json", "validation", "unicode"])
async def test_a_store_value_error_is_a_503_never_a_400_and_never_echoed(
    app_state, monkeypatch, failure: str,
) -> None:
    """``json.JSONDecodeError``, pydantic's ``ValidationError`` and ``UnicodeDecodeError``
    are ``ValueError`` too: a store raising one while reading is a store failure (503,
    nothing measured), not a refused request, and none of its text reaches the caller."""
    secret = "10.66.6.6 api_key=s3cr3t"

    async def corrupt(**_kw: Any) -> Any:
        if failure == "json":
            json.loads('{"title": "' + secret)
        if failure == "validation":
            Case.model_validate({"case_id": secret})
        raise UnicodeDecodeError("utf-8", secret.encode(), 0, 1, "bad byte")

    monkeypatch.setattr(app_state.cases, "scan_page", corrupt)
    response = await _get(app_state, by="rule", window="now-7d")
    assert response.status_code == 503, response.text
    detail = response.json()["detail"]
    assert detail == {"code": "breakdown_unavailable",
                      "message": "The store could not be read, so this breakdown is not available right now."}
    assert "10.66" not in response.text and "s3cr3t" not in response.text


def test_the_engine_tells_a_refused_request_from_a_store_failure() -> None:
    assert issubclass(AggregateRequestError, ValueError)   # every existing caller still works
    assert issubclass(BucketBudgetError, AggregateRequestError)
    with pytest.raises(AggregateRequestError):
        normalise_case_filters({"nonsense": "x"})
    with pytest.raises(AggregateRequestError):
        normalise_case_filters({"verdict": "maybe"})
    with pytest.raises(BucketBudgetError) as raised:
        from app.engine.case_aggregate import validate_case_spec

        validate_case_spec(CaseAggregateSpec(
            window=resolve_window("2010-01-01..2026-01-01"), bucket="hour",
        ))
    assert raised.value.unit == "hour" and raised.value.count > 5000 and raised.value.suggestion


async def test_a_push_down_value_error_folds_instead_of_refusing(app_state, monkeypatch) -> None:
    """A push-down that fails with a ``ValueError`` of its own (a corrupt aggregation
    response) is a glitch: the engine folds and answers, rather than reporting the
    request as invalid."""
    await _seed(app_state, corpus())

    async def broken(_spec: Any) -> Any:
        raise json.JSONDecodeError("corrupt aggregation", "{", 0)

    monkeypatch.setattr(app_state.cases, "aggregate", broken)
    result = await aggregate_cases(app_state.cases, CaseAggregateSpec(
        window=resolve_window("all"), group_by=("status",),
    ))
    assert result.method == "fold" and result.total == 7 and result.exact


async def test_a_store_that_cannot_be_read_is_a_503_never_a_zero(app_state, monkeypatch) -> None:
    async def boom(**_kw: Any) -> Any:
        raise RuntimeError("store down at 10.0.0.9:9200")

    monkeypatch.setattr(app_state.cases, "scan_page", boom)
    response = await _get(app_state, by="rule", window="now-7d")
    assert response.status_code == 503
    detail = response.json()["detail"]
    assert detail["code"] == "breakdown_unavailable" and "10.0.0.9" not in detail["message"]


async def test_a_scan_that_fails_partway_is_a_lower_bound(app_state) -> None:
    repo = _FastRepo(_scale_cases(2500))
    original = repo.scan_page
    calls = {"n": 0}

    async def flaky(**kw: Any) -> Any:
        calls["n"] += 1
        if calls["n"] == 2:
            raise RuntimeError("shard lost at 10.0.0.9")
        return await original(**kw)

    repo.scan_page = flaky  # type: ignore[method-assign]
    app_state._real_cases = repo  # noqa: SLF001 - the store the endpoint reads
    body = await _breakdown(app_state, by="verdict", window="all")
    assert body["exact"] is False and body["partial"] is True
    assert body["partial_reason"] == (
        "The case store stopped answering partway, so these figures are lower bounds."
    )
    assert 0 < body["total"] <= 1000
    assert "10.0.0.9" not in str(body)


# --------------------------------------------------------------------------- #
# 4. Grants, row scope, Demo, #6 and no audit
# --------------------------------------------------------------------------- #
def _rbac_client(denies: dict[str, list[str]]) -> TestClient:
    from app.api.routes import router as monolith_router
    from app.config import Secrets
    from app.es.fake import InMemoryESClient
    from app.llm.providers import MockProvider
    from app.state import AppState

    secrets = Secrets(
        _env_file=None, es_store_enabled=False, redis_url="", anthropic_api_key=None,
        openai_api_key=None, auth_enabled=True, auth_jwt_secret="breakdown-rbac-secret",
        auth_seed_admin=True,
    )
    mock = MockProvider()

    @asynccontextmanager
    async def lifespan(api: FastAPI):
        state = AppState.create(secrets=secrets, es=InMemoryESClient(),
                                provider_overrides={"anthropic": mock, "openai": mock, "mock": mock})
        await state.startup(start_poller=False)
        prefs = state.prefs.model_copy(update={"setup_complete": True})
        prefs = prefs.model_copy(update={"rbac": prefs.rbac.model_copy(update={
            "enabled": True, "denies": {"analyst_tier1": denies},
        })})
        await state.update_prefs(prefs)
        api.state.tlsoc = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    api.include_router(monolith_router, dependencies=[Depends(require_auth)])
    api.include_router(metrics_router, dependencies=[Depends(require_auth)])
    return TestClient(api)


def _login_as_tier1(client: TestClient) -> None:
    assert client.post("/api/auth/login", json={"username": "Admin", "password": "Admin@123"}).status_code == 200
    created = client.post("/api/users", json={
        "username": "tier1", "password": "tier1-pass-1234", "role": "analyst_tier1",
    })
    assert created.status_code == 200, created.text
    client.post("/api/auth/logout")
    assert client.post("/api/auth/login", json={"username": "tier1", "password": "tier1-pass-1234"}).status_code == 200


def test_cases_need_metrics_view_and_usage_needs_cost_view() -> None:
    with _rbac_client({"metrics": ["view"]}) as client:
        assert client.get("/api/metrics/breakdown", params={"by": "rule"}).status_code == 401
        _login_as_tier1(client)
        # The grant is checked before the parameters: nothing leaks to a denied caller.
        assert client.get("/api/metrics/breakdown", params={"by": "nonsense"}).status_code == 403
        assert client.get("/api/metrics/breakdown", params={"by": "rule"}).status_code == 403
        usage = client.get("/api/metrics/breakdown", params={"kind": "usage", "by": "surface"})
        assert usage.status_code == 200, usage.text
    with _rbac_client({"cost": ["view"]}) as client:
        _login_as_tier1(client)
        assert client.get("/api/metrics/breakdown", params={"by": "rule"}).status_code == 200
        assert client.get("/api/metrics/breakdown",
                          params={"kind": "usage", "by": "surface"}).status_code == 403


async def test_row_level_scope_refuses_case_breakdowns_only(app_state, monkeypatch) -> None:
    import app.engine.chat_starters as starters

    seen: list[str] = []

    def scoped(state: Any, role: str) -> bool:
        seen.append(role)
        return True

    monkeypatch.setattr(starters, "object_scoped", scoped)
    response = await _get(app_state, by="rule")
    assert response.status_code == 409
    detail = response.json()["detail"]
    assert detail == {"code": "breakdown_scope_unsupported",
                      "message": "Case breakdowns are hidden while row-level data scope is on."}
    assert seen == [""]                              # auth off: no role
    usage = await _get(app_state, kind="usage", by="surface")
    assert usage.status_code == 200


async def test_demo_mode_reads_the_demo_store(app_state) -> None:
    await _seed(app_state, corpus())
    real = await _breakdown(app_state, by="verdict", window="all")
    assert real["total"] == 7
    await app_state.enable_demo(mode="seeded", seed=7, history_days=14)
    try:
        demo_cases = await _all_cases(app_state.cases)
        assert demo_cases and not {"c1", "c2"} & {c.case_id for c in demo_cases}
        demo = await _breakdown(app_state, by="verdict", window="all")
        assert demo["total"] == len(demo_cases)
    finally:
        await app_state.disable_demo()
    assert (await _breakdown(app_state, by="verdict", window="all"))["total"] == 7


async def test_a_breakdown_never_calls_a_model_and_writes_no_audit_row(app_state, monkeypatch) -> None:
    from app.llm.gateway import LLMGateway

    await _seed(app_state, corpus())

    async def no_model(*_a: Any, **_kw: Any) -> Any:
        raise AssertionError("the breakdown must not call the model gateway (#6)")

    for name in ("complete", "embed", "embed_with_provenance"):
        monkeypatch.setattr(LLMGateway, name, no_model)
    before_audit = len(await app_state.audit.records(limit=1000))
    before_usage = len(await app_state.usage_store.records(limit=1000))
    for by in BREAKDOWN_CASE_FIELDS:
        await _breakdown(app_state, by=by, window="now-7d")
    await _breakdown(app_state, kind="usage", by="model")
    assert len(await app_state.audit.records(limit=1000)) == before_audit
    assert len(await app_state.usage_store.records(limit=1000)) == before_usage


# --------------------------------------------------------------------------- #
# 5. Parity with the chat's case_stats
# --------------------------------------------------------------------------- #
async def _all_cases(store: Any) -> list[Case]:
    out: list[Case] = []
    offset = 0
    while True:
        page, total = await store.list(limit=500, offset=offset)
        out.extend(page)
        offset += len(page)
        if not page or offset >= total:
            return out


async def _case_stats(ctx: Any, by: str, window: str, metrics: tuple[str, ...], **filters: Any) -> dict[str, Any]:
    out = await CaseStatsTool().run(ctx, group_by=[by], metrics=list(metrics), window=window, top_n=50,
                                    **filters)
    assert out.ok, out.error
    return out.observation


async def _assert_parity(state: Any, store: Any, by: str, window: str, **filters: Any) -> None:
    """The endpoint and ``case_stats`` agree on the total and on every group's every
    metric for one (by, window, filters) question."""
    params: dict[str, Any] = {"by": by, "window": window, "top": 50}
    if filters.get("status_group") == "active":
        params["status_group"] = "open"
    body = await _breakdown(state, **params)
    ctx = make_ctx(cases=store, prefs=state.execution_prefs)
    first = await _case_stats(ctx, by, window, NEW_METRICS, **filters)
    second = await _case_stats(ctx, by, window, ("analyst_fp", "open_now"), **filters)
    assert body["total"] == first["total"] == second["total"], (by, window)
    assert body["exact"] is first["exact"] is True
    chat_rows: dict[str, dict[str, Any]] = {}
    for obs in (first, second):
        for group in obs.get("groups", []):
            chat_rows.setdefault(group["key"][by], {}).update(group["metrics"])
    endpoint_rows = {group_label(by, g["key"]): g for g in body["groups"]}
    for label, group in endpoint_rows.items():
        chat = chat_rows[label]
        for metric in (*NEW_METRICS, "analyst_fp", "open_now", "count"):
            if group["count"] == 0 and metric not in chat:
                # An open-stock-only row (no case in the window, open cases outside it):
                # only the call that asked for open_now lists it, and nothing in the
                # window can be verdicted or graded.
                assert group[metric] == 0, (by, window, label, metric)
                continue
            assert group[metric] == chat[metric], (by, window, label, metric)
    assert {k for k, v in chat_rows.items() if v.get("count")} == {
        k for k, g in endpoint_rows.items() if g["count"]
    }


@pytest.mark.parametrize("by", BREAKDOWN_CASE_FIELDS)
async def test_parity_with_case_stats_on_the_hand_corpus(app_state, by: str) -> None:
    await _seed(app_state, corpus())
    for window in ("now-7d", "all", "now-24h"):
        await _assert_parity(app_state, app_state.cases, by, window)
    await _assert_parity(app_state, app_state.cases, by, "all", status_group="active")


async def test_parity_with_case_stats_on_the_demo_dataset(app_state) -> None:
    await app_state.enable_demo(mode="seeded", seed=1337, history_days=45)
    try:
        # One absolute range for both calls, so the test cannot straddle a day change.
        lo = (NOW - timedelta(days=30)).date().isoformat()
        hi = (NOW - timedelta(days=3)).date().isoformat()
        for by in BREAKDOWN_CASE_FIELDS:
            for window in ("all", f"{lo}..{hi}"):
                await _assert_parity(app_state, app_state.cases, by, window)
    finally:
        await app_state.disable_demo()


# --------------------------------------------------------------------------- #
# 6. Scale: a 30,000-case fixture
# --------------------------------------------------------------------------- #
class _FastRepo(CaseRepository):
    """A repository over in-memory ``Case`` objects with a cheap ``scan_page`` (window and
    status pre-filters on precomputed instants), so a full-population fold of 30,000
    cases stays a few seconds. It implements only the public repository surface: the
    engine folds it exactly as it folds a third-party store."""

    def __init__(self, cases: list[Case]) -> None:
        self.cases = sorted(cases, key=lambda c: (c.created_at, c.case_id))
        self.ts = [parse_es_timestamp(c.created_at) for c in self.cases]

    async def save(self, case: Case) -> None:  # pragma: no cover - read-only fixture
        raise AssertionError("read-only")

    async def get(self, case_id: str) -> Case | None:
        return next((c for c in self.cases if c.case_id == case_id), None)

    async def find_open_by_signature(self, signature: str) -> Case | None:
        return None

    async def list(self, *, status=None, source_surface=None, entity_value=None, limit=50,
                   offset=0, sort_field="created_at", sort_order="desc"):
        return self.cases[offset: offset + limit], len(self.cases)

    async def list_scans(self, limit: int = 50):
        return [], 0

    async def count_new_scans(self, since_iso: str) -> int:
        return 0

    async def scan_page(self, *, limit: int = 1000, cursor: Any = None, created_from: Any = None,
                        created_to: Any = None, raw: bool = False, statuses: Any = None,
                        fields: Any = None):
        start = int(cursor or 0)
        wanted = set(statuses) if statuses is not None else None
        rows = []
        for case, ts in zip(self.cases[start:start + limit], self.ts[start:start + limit]):
            if ts is not None and ((created_from is not None and ts < created_from)
                                   or (created_to is not None and ts >= created_to)):
                continue
            if wanted is not None and case.status.value not in wanted:
                continue
            rows.append(case)
        nxt = start + limit if start + limit < len(self.cases) else None
        return rows, nxt, len(self.cases), "point_in_time"


def _scale_cases(n: int) -> list[Case]:
    rng = random.Random(30_000)
    statuses = list(CaseStatus)
    verdicts = [Verdict.TRUE_POSITIVE, Verdict.FALSE_POSITIVE, Verdict.NEEDS_HUMAN, None]
    out: list[Case] = []
    for i in range(n):
        status = rng.choice(statuses)
        policy = status.value in _TERMINAL and rng.random() < 0.05
        out.append(Case(
            case_id=f"s{i:06d}", cluster_signature=f"sig-{i}",
            source_surface=rng.choice(list(SourceSurface)),
            entity=Entity(type=EntityType.IP, value=f"10.1.{i % 250}.{i % 7}"),
            created_at=(NOW - timedelta(seconds=rng.randint(60, 50 * 86_400))).isoformat(),
            rule_ids=rng.sample(["r-ssh", "r-web", "R-SSH", "r-dns", "r-smb"], rng.randint(0, 2)),
            mitre=rng.sample(["T1110", "T1059.001", "T1566", "T1078", "bogus"], rng.randint(0, 2)),
            verdict=None if policy else rng.choice(verdicts),
            status=status,
            decision_by=(DecisionBy.ANALYST_POLICY if policy
                         else rng.choice([DecisionBy.AGENT, DecisionBy.ANALYST, DecisionBy.SYSTEM, None])),
            analyst_policy={"policy_id": "p"} if policy else None,
            disposition=Disposition.FALSE_POSITIVE if policy else None,
            severity_band=rng.choice(["critical", "high", "medium", "low", "info"]),
            source_id=rng.choice([None, "src-a", "src-b", "src-c"]),
            assignee=rng.choice(["", "alice", "bob", "carol"]),
            feedback=(_feedback(rng.choice(["true_positive", "false_positive", "unknown"]))
                      if rng.random() < 0.15 else []),
        ))
    return out


def _truth(cases: list[Case], by: str) -> dict[Any, dict[str, int]]:
    """An INDEPENDENT brute-force count of every metric per group of ``by`` (all time),
    written from the documented semantics without the engine's code."""
    rows: dict[Any, Counter] = {}
    for case in cases:
        status = case.status.value
        policy = is_policy_closed(case)
        verdict = case.verdict.value if case.verdict else None
        outcome = None if policy else analyst_confirmed_outcome(case)[0]
        if by == "rule":
            keys = list(dict.fromkeys(case.rule_ids)) or [None]
        elif by in ("mitre_technique", "mitre_tactic"):
            ids, tactics = [], []
            for raw in case.mitre:
                meta = mitre_engine.technique(raw)
                if isinstance(meta, dict) and meta.get("id") and meta["id"].upper() not in ids:
                    ids.append(meta["id"].upper())
                    tactics += [t for t in meta.get("tactics") or [] if t not in tactics]
            keys = (ids if by == "mitre_technique" else tactics) or [None]
        elif by == "severity":
            keys = [band_of_case(case, None)]
        elif by == "status":
            keys = [status]
        elif by == "verdict":
            keys = [verdict]
        elif by == "assignee":
            keys = [case.assignee.strip() or None]
        elif by == "source":
            keys = [case.source_id or None]
        elif by == "closed_by":
            keys = [None if status not in _TERMINAL else "analyst_policy" if policy else
                    {"agent": "agent", "analyst": "analyst"}.get(
                        case.decision_by.value if case.decision_by else "", "system")]
        else:  # pragma: no cover
            raise AssertionError(by)
        for key in keys:
            row = rows.setdefault(key, Counter())
            row["count"] += 1
            row["open_now"] += status in _ACTIVE
            if not policy and verdict is not None:
                row["verdicted"] += 1
                row["verdict_tp"] += verdict == "TRUE_POSITIVE"
                row["verdict_fp"] += verdict == "FALSE_POSITIVE"
                row["verdict_needs_human"] += verdict == "NEEDS_HUMAN"
            row["analyst_tp"] += outcome == "true_positive"
            row["analyst_fp"] += outcome == "false_positive"
    for row in rows.values():
        row["analyst_ungraded"] = row["count"] - row["analyst_tp"] - row["analyst_fp"]
    return {k: dict(v) for k, v in rows.items()}


@pytest.fixture(scope="module")
def scale_cases() -> list[Case]:
    return _scale_cases(30_000)


async def test_parity_and_ground_truth_on_a_30000_case_fixture(app_state, scale_cases) -> None:
    """Every ``by``: the endpoint equals an independent brute-force count of every metric
    over 30,000 cases, and equals the chat's ``case_stats`` for the six new metrics."""
    repo = _FastRepo(scale_cases)
    app_state._real_cases = repo  # noqa: SLF001 - the store the endpoint reads
    ctx = make_ctx(cases=repo, prefs=app_state.execution_prefs)
    for by in BREAKDOWN_CASE_FIELDS:
        body = await _breakdown(app_state, by=by, window="all", top=50)
        assert body["total"] == 30_000 and body["exact"] is True
        assert body["other"] is None, by            # every group fits in 50
        truth = _truth(scale_cases, by)
        got = {g["key"]: {m: g[m] for m in BREAKDOWN_CASE_METRICS} for g in body["groups"]}
        assert got == {k: {m: v.get(m, 0) for m in BREAKDOWN_CASE_METRICS} for k, v in truth.items()}, by
        for group in body["groups"]:
            _assert_families(group)
        chat = await _case_stats(ctx, by, "all", NEW_METRICS)
        assert chat["total"] == 30_000
        chat_rows = {g["key"][by]: g["metrics"] for g in chat["groups"]}
        assert chat_rows == {group_label(by, k): {"count": v["count"], **{m: v[m] for m in NEW_METRICS}}
                             for k, v in got.items() if v["count"]}, by


def test_the_endpoint_asks_for_exactly_the_documented_metrics() -> None:
    assert BREAKDOWN_SPEC_METRICS == BREAKDOWN_CASE_METRICS
    assert set(BREAKDOWN_SPEC_METRICS) <= set(CASE_METRICS)


def test_the_new_metrics_are_offered_to_chat_too() -> None:
    from app.agents.chat_tools import stats

    assert set(NEW_METRICS) <= set(stats.METRICS)
    assert set(stats.METRICS) == set(CASE_METRICS)
    assert all(stats._METRIC_UNITS[m] == "count" for m in NEW_METRICS)  # noqa: SLF001
    assert all(stats._METRIC_LABELS[m] for m in NEW_METRICS)  # noqa: SLF001


# --------------------------------------------------------------------------- #
# 7. Resource bounds: a shared answer, one read per question, bounded reads
# --------------------------------------------------------------------------- #
class _CountingRepo(_FastRepo):
    """``_FastRepo`` that records every page read (its cursor and field projection),
    can hold each read open, and tracks how many reads overlap."""

    def __init__(self, cases: list[Case], *, delay: float = 0.0) -> None:
        super().__init__(cases)
        self.calls: list[tuple[Any, Any]] = []
        self.delay = delay
        self.active = 0
        self.peak = 0

    async def scan_page(self, *, limit: int = 1000, cursor: Any = None, created_from: Any = None,
                        created_to: Any = None, raw: bool = False, statuses: Any = None,
                        fields: Any = None):
        self.calls.append((cursor, fields))
        self.active += 1
        self.peak = max(self.peak, self.active)
        try:
            if self.delay:
                await asyncio.sleep(self.delay)
            return await super().scan_page(limit=limit, cursor=cursor, created_from=created_from,
                                           created_to=created_to, raw=raw, statuses=statuses,
                                           fields=fields)
        finally:
            self.active -= 1

    def scans(self) -> int:
        """Scans started (a scan's first page has no cursor)."""
        return sum(1 for cursor, _ in self.calls if cursor is None)


async def test_concurrent_identical_questions_share_one_read(app_state) -> None:
    repo = _CountingRepo(corpus(), delay=0.05)
    app_state._real_cases = repo  # noqa: SLF001 - the store the endpoint reads
    one = await _breakdown(app_state, by="rule", window="now-7d")
    per_question = repo.scans()
    assert per_question >= 1
    invalidate_breakdown_cache()
    repo.calls.clear()
    bodies = await asyncio.gather(*(_breakdown(app_state, by="rule", window="now-7d") for _ in range(5)))
    assert repo.scans() == per_question                 # five viewers, one read
    assert all(body == bodies[0] for body in bodies)
    assert bodies[0]["groups"] == one["groups"]


async def test_a_fresh_answer_is_shared_and_expires(app_state, monkeypatch) -> None:
    repo = _CountingRepo(corpus())
    app_state._real_cases = repo  # noqa: SLF001
    first = await _breakdown(app_state, by="severity", window="all")
    after_first = repo.scans()
    again = await _breakdown(app_state, by="severity", window="all")
    assert repo.scans() == after_first and again == first      # served from the shared answer
    await _breakdown(app_state, by="severity", window="all", top=5)
    assert repo.scans() > after_first                           # another question reads
    monkeypatch.setattr(routes_metrics, "BREAKDOWN_CACHE_TTL_SECONDS", 0.0)
    invalidate_breakdown_cache()
    before = repo.scans()
    await _breakdown(app_state, by="severity", window="all")
    await _breakdown(app_state, by="severity", window="all")
    assert repo.scans() == before + 2 * (after_first)           # nothing kept at TTL 0


async def test_the_shared_answer_never_crosses_a_demo_switch(app_state) -> None:
    await _seed(app_state, corpus())
    real = await _breakdown(app_state, by="verdict", window="all")
    await app_state.enable_demo(mode="seeded", seed=7, history_days=14)
    try:
        demo = await _breakdown(app_state, by="verdict", window="all")
        demo_total = len(await _all_cases(app_state.cases))
        assert demo["total"] == demo_total != real["total"]
    finally:
        await app_state.disable_demo()
    assert (await _breakdown(app_state, by="verdict", window="all"))["total"] == real["total"] == 7


async def test_a_partial_read_and_a_failure_are_never_kept(app_state) -> None:
    repo = _CountingRepo(_scale_cases(2500))
    original = repo.scan_page
    state = {"fail_second_page": True, "down": False}

    async def flaky(**kw: Any) -> Any:
        if state["down"]:
            raise RuntimeError("store down")
        if state["fail_second_page"] and kw.get("cursor") is not None:
            raise RuntimeError("shard lost")
        return await original(**kw)

    repo.scan_page = flaky  # type: ignore[method-assign]
    app_state._real_cases = repo  # noqa: SLF001
    partial = await _breakdown(app_state, by="verdict", window="all")
    assert partial["partial"] is True
    state["fail_second_page"] = False
    whole = await _breakdown(app_state, by="verdict", window="all")   # read again, not the cut answer
    assert whole["partial"] is False and whole["total"] == 2500
    invalidate_breakdown_cache()
    state["down"] = True
    assert (await _get(app_state, by="verdict", window="all")).status_code == 503
    state["down"] = False
    assert (await _breakdown(app_state, by="verdict", window="all"))["total"] == 2500


async def test_at_most_two_reads_run_at_once(app_state) -> None:
    repo = _CountingRepo(corpus(), delay=0.05)
    app_state._real_cases = repo  # noqa: SLF001
    questions = ["rule", "severity", "verdict", "status", "source", "assignee"]
    bodies = await asyncio.gather(*(_breakdown(app_state, by=by, window="all") for by in questions))
    assert all(body["total"] == 7 for body in bodies)
    assert repo.peak == routes_metrics.BREAKDOWN_MAX_CONCURRENT_READS == 2


async def test_a_read_past_its_time_is_a_503_and_not_a_zero(app_state, monkeypatch) -> None:
    repo = _CountingRepo(corpus(), delay=5.0)
    app_state._real_cases = repo  # noqa: SLF001
    monkeypatch.setattr(routes_metrics, "BREAKDOWN_READ_TIMEOUT_SECONDS", 0.2)
    response = await _get(app_state, by="rule", window="all")
    assert response.status_code == 503
    assert response.json()["detail"] == {
        "code": "breakdown_unavailable",
        "message": "This breakdown took too long to read, so it is not available right now. "
                   "Try a shorter window.",
    }


async def test_the_grant_and_the_scope_are_checked_before_a_shared_answer(app_state, monkeypatch) -> None:
    """A shared answer is never served to a caller the row-level scope refuses."""
    import app.engine.chat_starters as starters

    await _seed(app_state, corpus())
    assert (await _get(app_state, by="rule")).status_code == 200      # now shared
    monkeypatch.setattr(starters, "object_scoped", lambda _state, _role: True)
    assert (await _get(app_state, by="rule")).status_code == 409


async def test_a_fold_that_validates_the_model_runs_off_the_event_loop(app_state, monkeypatch) -> None:
    """The analyst family validates the case model (from its projected fields) and a
    whole-document fold validates every document: each page is folded in a worker
    thread (the loop keeps serving), while a count-only fold stays on the loop (cheap)."""
    import threading

    from app.engine import case_aggregate

    await _seed(app_state, corpus())
    seen: list[bool] = []
    real_view = case_aggregate._CaseView

    class Spy(real_view):  # type: ignore[misc, valid-type]
        def __init__(self, row: Any, prefs: Any, **kw: Any) -> None:
            seen.append(threading.current_thread() is threading.main_thread())
            super().__init__(row, prefs, **kw)

    monkeypatch.setattr(case_aggregate, "_CaseView", Spy)
    loop_thread = threading.main_thread()
    assert threading.current_thread() is loop_thread
    for metrics, group_by in ((("analyst_tp",), ("rule",)), (("count",), ("severity",))):
        seen.clear()
        await aggregate_cases(app_state.cases, CaseAggregateSpec(
            window=resolve_window("all"), group_by=group_by, metrics=metrics,
        ))
        assert seen and not any(seen), (metrics, group_by)   # every case validated off the loop
    seen.clear()
    await case_aggregate.fold_cases(app_state.cases, CaseAggregateSpec(
        window=resolve_window("all"), group_by=("rule",), metrics=("count",),
    ))
    assert seen and all(seen)                            # a count-only fold stays on the loop


# --------------------------------------------------------------------------- #
# 8. Buckets: advice in the endpoint's own units, refused before the read
# --------------------------------------------------------------------------- #
async def test_too_many_buckets_names_a_unit_the_endpoint_offers(app_state) -> None:
    hourly = (await _get(app_state, by="severity", bucket="hour", window="2010-01-01..2026-01-01")).json()
    assert re.fullmatch(
        r"1\d{5} hour buckets is too many for this window \(at most 5000\); "
        r"use bucket=week or a shorter window",
        hourly["detail"]["message"],
    ), hourly
    daily = (await _get(app_state, by="severity", bucket="day", window="2010-01-01..2026-01-01")).json()
    assert "use bucket=week" in daily["detail"]["message"]
    for message in (hourly["detail"]["message"], daily["detail"]["message"]):
        assert "month" not in message and "quarter" not in message and "year" not in message


async def test_all_time_buckets_are_refused_before_the_whole_document_fold(app_state) -> None:
    old = [_case(f"o{i}", hours_ago=24 * 400 + i, rule_ids=["r-old"], verdict=Verdict.FALSE_POSITIVE,
                 status=CaseStatus.CLOSED) for i in range(3)]
    repo = _CountingRepo(corpus() + old)
    app_state._real_cases = repo  # noqa: SLF001
    response = await _get(app_state, by="severity", bucket="hour", window="all")
    assert response.status_code == 400
    assert "use bucket=day or a shorter window" in response.json()["detail"]["message"]
    # Only the count-only probe read the store (a projected scan), never the whole fold.
    assert repo.calls and all(fields is not None for _, fields in repo.calls)
    fine = await _breakdown(app_state, by="severity", bucket="week", window="all")
    assert fine["total"] == 10


# --------------------------------------------------------------------------- #
# 9. Disclosures: undated cases and each bucket's share of "Other"
# --------------------------------------------------------------------------- #
async def test_undated_cases_are_disclosed_never_silently_dropped(app_state) -> None:
    from app.api.routes_metrics import _undated

    undated = _case("u1", rule_ids=["r-ssh"], verdict=Verdict.NEEDS_HUMAN, status=CaseStatus.OPEN)
    undated = undated.model_copy(update={"created_at": "not a date"})
    repo = _FastRepo(corpus() + [undated])
    app_state._real_cases = repo  # noqa: SLF001
    spec_week = CaseAggregateSpec(window=resolve_window("now-7d"), group_by=("rule",),
                                  metrics=BREAKDOWN_SPEC_METRICS)
    week = await aggregate_cases(repo, spec_week)
    assert _undated(week) == {"missing_created": 1, "missing_in_total": False}
    all_time = await aggregate_cases(repo, CaseAggregateSpec(
        window=resolve_window("all"), group_by=("rule",), metrics=("count",)))
    assert _undated(all_time) == {"missing_created": 1, "missing_in_total": True}
    body = await _breakdown(app_state, by="rule", window="now-7d")
    assert body["total"] == 6                               # not placed in the week
    everything = await _breakdown(app_state, by="rule", window="all")
    assert everything["total"] == 8                         # counted in all time
    # The disclosure reaches the wire on every response: a bounded window says the
    # undated case is outside ``total``, all time says it is inside (its "no date" row).
    assert (body["missing_created"], body["missing_in_total"]) == (1, False)
    assert (everything["missing_created"], everything["missing_in_total"]) == (1, True)
    # A store with every case dated discloses nothing.
    app_state._real_cases = _FastRepo(corpus())  # noqa: SLF001
    dated = await _breakdown(app_state, by="rule", window="now-7d")
    assert (dated["missing_created"], dated["missing_in_total"]) == (0, False)
    # Chat's case_stats states the same total and the same undated count for the window.
    ctx = make_ctx(cases=repo, prefs=app_state.execution_prefs)
    chat = await _case_stats(ctx, "rule", "now-7d", ("count",))
    assert chat["total"] == body["total"]
    assert (chat["missing_created"], chat["missing_created_in_total"]) == (1, False)


async def test_each_bucket_keeps_its_share_of_other(app_state) -> None:
    from app.api.routes_metrics import _breakdown_buckets, _other_per_bucket

    repo = _FastRepo(_scale_cases(3000))
    app_state._real_cases = repo  # noqa: SLF001
    result = await aggregate_cases(repo, CaseAggregateSpec(
        window=resolve_window("now-30d"), group_by=("verdict",), bucket="week", top_n=1,
        metrics=BREAKDOWN_SPEC_METRICS,
    ))
    assert result.other
    per_bucket_total: Counter = Counter()
    listed: Counter = Counter()
    for row in result.groups:
        per_bucket_total[row["bucket"]] += row["metrics"]["count"]
        if not row.get("other"):
            listed[row["bucket"]] += row["metrics"]["count"]
    other = _other_per_bucket(result, "count")
    assert sum(other.values()) == result.other["metrics"]["count"]
    for label, total in per_bucket_total.items():
        assert listed[label] + other.get(label, 0) == total, label
    buckets = _breakdown_buckets(result, metric="count")
    assert [b.label for b in buckets] == [label for label, _ in result.buckets]
    assert [b.other_count for b in buckets] == [other.get(b.label, 0) for b in buckets]
    assert sum(b.other_count for b in buckets) == result.other["metrics"]["count"]
    # On the wire: every bucket carries its share, and its listed groups plus that
    # share are exactly the bucket's total, so no record is lost in "Other".
    body = await _breakdown(app_state, by="verdict", window="now-30d", bucket="week", top=1)
    assert body["other"] and body["buckets"]
    for bucket in body["buckets"]:
        listed_here = sum(g["count"] for g in body["groups"] if g["bucket"] == bucket["label"])
        assert listed_here + bucket["other_count"] == per_bucket_total[bucket["label"]], bucket
    assert sum(b["other_count"] for b in body["buckets"]) == body["other"]["count"]
    # Nothing was cut past ``top``: no bucket claims a share of an absent "Other".
    whole = await _breakdown(app_state, by="verdict", window="now-30d", bucket="week", top=50)
    assert not whole["other"]
    assert all(b.get("other_count") is None for b in whole["buckets"])


# --------------------------------------------------------------------------- #
# 10. The SQL repository and the projected fold
# --------------------------------------------------------------------------- #
@pytest.fixture
async def sql_cases():
    from app.stores.sql import SqlCaseRepository, build_async_engine, create_all

    engine = build_async_engine("sqlite+aiosqlite:///:memory:")
    await create_all(engine)
    repo = SqlCaseRepository(engine)
    for case in corpus():
        await repo.save(case)
    yield repo
    await engine.dispose()


def _comparable(body: dict[str, Any]) -> dict[str, Any]:
    """A response without its measurement instants (two reads a moment apart)."""
    return {k: v for k, v in body.items() if k not in ("window_from", "window_to")}


@pytest.mark.parametrize("by", BREAKDOWN_CASE_FIELDS)
async def test_parity_on_the_sql_repository(app_state, sql_cases, by: str) -> None:
    """The SQL repository's raw pages (JSON documents decoded in a worker thread, the
    status pre-filter, the canonical ``created_at`` order) answer every question exactly
    as the Elasticsearch store does, and as the chat's ``case_stats`` does."""
    await _seed(app_state, corpus())
    then = "verdict" if by != "verdict" else "severity"
    questions: list[dict[str, Any]] = [
        {"by": by, "window": "now-7d", "top": 50},
        {"by": by, "window": "all", "top": 50},
        {"by": by, "window": "all", "status_group": "open", "top": 50},
        {"by": by, "window": "all", "filter_rule": "r-ssh", "top": 50},
        {"by": by, "window": "now-7d", "bucket": "day", "top": 50},
        {"by": by, "then": then, "window": "all", "top": 50},
    ]
    on_es = [await _breakdown(app_state, **q) for q in questions]
    app_state._real_cases = sql_cases  # noqa: SLF001 - the store the endpoint reads
    for question, expected in zip(questions, on_es):
        got = await _breakdown(app_state, **question)
        assert _comparable(got) == _comparable(expected), question
    for window in ("now-7d", "all", "now-24h"):
        await _assert_parity(app_state, sql_cases, by, window)
    await _assert_parity(app_state, sql_cases, by, "all", status_group="active")


def _policy_overwritten_corpus() -> list[Case]:
    """The corpus plus a policy close whose ``decision_by`` a later analyst action
    overwrote (the durable ``analyst_policy`` payload remains): still a policy close."""
    overwritten = _case("p2", rule_ids=["r-dns"], verdict=Verdict.FALSE_POSITIVE,
                        status=CaseStatus.CLOSED, decision_by=DecisionBy.ANALYST,
                        analyst_policy={"policy_id": "p9"}, severity_band="low")
    return corpus() + [overwritten]


@pytest.mark.parametrize("group_by", [(), ("rule",), ("verdict",), ("closed_by",), ("status_group",)])
async def test_the_projected_verdict_fold_equals_the_whole_document_fold(app_state, group_by) -> None:
    """``count``, ``open_now`` and the AI verdict family fold from a field projection
    (``verdict``, ``decision_by``, ``analyst_policy``); adding a metric that reads the
    whole document (``mean_risk``) forces whole documents. Both must agree on every
    verdict figure, including a policy close whose decider was overwritten, so a field
    the projection forgot cannot go unnoticed."""
    await _seed(app_state, _policy_overwritten_corpus())
    verdict_metrics = ("count", "open_now", "verdicted", "verdict_tp", "verdict_fp", "verdict_needs_human")
    projected = CaseAggregateSpec(window=resolve_window("all"), group_by=group_by, metrics=verdict_metrics)
    whole = CaseAggregateSpec(window=resolve_window("all"), group_by=group_by,
                              metrics=verdict_metrics + ("mean_risk",))
    assert _raw_projection(projected, {}) is not None
    assert _raw_projection(whole, {}) is None
    from app.engine.case_aggregate import fold_cases

    a = await fold_cases(app_state.cases, projected)
    b = await fold_cases(app_state.cases, whole)
    assert a.total == b.total == 8 and a.exact and b.exact
    assert {m: a.totals[m] for m in verdict_metrics} == {m: b.totals[m] for m in verdict_metrics}
    assert a.totals["verdicted"] == 5                    # c1 c2 c3 c5 c6; the policy closes are out

    def rows(result: Any) -> dict[Any, dict[str, Any]]:
        return {tuple(sorted((row["key"] or {}).items(), key=str)): {m: row["metrics"][m] for m in verdict_metrics}
                for row in result.groups}

    assert rows(a) == rows(b)


# --------------------------------------------------------------------------- #
# 11. The analyst family from its projected fields (Round 14 review)
# --------------------------------------------------------------------------- #
def _classified(cid: str, disposition: Disposition, *, declared: bool, **kw: Any) -> Case:
    """An analyst close that classified the case through the history: a dedicated
    ``set_disposition`` verb, or a close that DECLARED its disposition."""
    entry: dict[str, Any] = {"event": "analyst_action", "ts": (NOW - timedelta(hours=1)).isoformat()}
    if declared:
        entry.update(action="close", classified_disposition=disposition.value)
    else:
        entry.update(action="set_disposition")
    return _case(cid, status=CaseStatus.CLOSED, decision_by=DecisionBy.ANALYST,
                 disposition=disposition, history=[entry], **kw)


def _analyst_corpus() -> list[Case]:
    """Every path ``analyst_confirmed_outcome`` takes: graded feedback (both labels and
    an ``unknown`` one that labels nothing), an explicit ``set_disposition``, a declared
    close, an undeclared close carrying the model's disposition (not ground truth), and
    the two policy closes (never graded)."""
    return _policy_overwritten_corpus() + [
        _classified("a1", Disposition.TRUE_POSITIVE, declared=False, rule_ids=["r-ssh"],
                    verdict=Verdict.TRUE_POSITIVE, assignee="alice", mitre=["T1110"]),
        _classified("a2", Disposition.FALSE_POSITIVE, declared=True, rule_ids=["r-web"],
                    verdict=Verdict.FALSE_POSITIVE, source_id="src-b"),
        _case("a3", rule_ids=["r-web"], verdict=Verdict.FALSE_POSITIVE, status=CaseStatus.CLOSED,
              decision_by=DecisionBy.ANALYST, disposition=Disposition.FALSE_POSITIVE,
              history=[{"event": "analyst_action", "action": "close",
                        "ts": (NOW - timedelta(hours=1)).isoformat()}]),
        _case("a4", rule_ids=["r-dns"], verdict=Verdict.NEEDS_HUMAN, status=CaseStatus.OPEN,
              feedback=[FeedbackEntry(actual_outcome="unknown", ts=(NOW - timedelta(hours=1)).isoformat())]),
    ]


_ANALYST_METRICS = ("analyst_tp", "analyst_fp", "analyst_ungraded")


def _rows_of(result: Any, metrics: tuple[str, ...]) -> dict[Any, dict[str, Any]]:
    return {
        (tuple(sorted((row["key"] or {}).items(), key=str)), row.get("bucket")):
            {m: row["metrics"][m] for m in metrics}
        for row in result.groups
    }


@pytest.mark.parametrize("group_by", [
    (), ("rule",), ("verdict",), ("closed_by",), ("assignee",), ("source",), ("mitre_technique",),
    ("rule", "verdict"),
])
async def test_the_projected_analyst_fold_equals_the_whole_document_fold(app_state, group_by) -> None:
    """The endpoint's metrics (both families) fold from a projection that carries the
    fields the analyst outcome reads plus the fields the case model requires. Adding a
    metric that reads the whole document forces whole documents; both agree on every
    figure of every row, so a field the projection forgot cannot go unnoticed."""
    from app.engine import case_aggregate
    from app.engine.case_aggregate import fold_cases

    cases = _analyst_corpus()
    await _seed(app_state, cases)
    projected = CaseAggregateSpec(window=resolve_window("all"), group_by=group_by,
                                  metrics=BREAKDOWN_SPEC_METRICS)
    whole = CaseAggregateSpec(window=resolve_window("all"), group_by=group_by,
                              metrics=BREAKDOWN_SPEC_METRICS + ("mean_risk",))
    fields = _raw_projection(projected, {})
    assert fields is not None and _raw_projection(whole, {}) is None
    assert set(case_aggregate._ANALYST_FIELDS) <= set(fields)
    assert "evidence" not in fields and "investigation" not in fields
    a = await fold_cases(app_state.cases, projected)
    b = await fold_cases(app_state.cases, whole)
    assert a.total == b.total == len(cases) and a.exact and b.exact
    assert {m: a.totals[m] for m in BREAKDOWN_SPEC_METRICS} == {m: b.totals[m] for m in BREAKDOWN_SPEC_METRICS}
    assert _rows_of(a, BREAKDOWN_SPEC_METRICS) == _rows_of(b, BREAKDOWN_SPEC_METRICS)
    # Worked out by hand: c2 (TP feedback), c5 (FP feedback), a1 (set_disposition, TP),
    # a2 (declared close, FP). c4 and p2 are policy closes, a3's close declared nothing
    # and a4's feedback labels nothing.
    assert (a.totals["analyst_tp"], a.totals["analyst_fp"]) == (2, 2)
    expected = Counter(
        analyst_confirmed_outcome(c)[0] for c in cases if not is_policy_closed(c)
    )
    assert (expected["true_positive"], expected["false_positive"]) == (2, 2)


def test_the_projection_names_every_field_the_case_model_requires() -> None:
    from app.engine import case_aggregate

    required = {name for name, info in Case.model_fields.items() if info.is_required()}
    assert set(case_aggregate._CASE_REQUIRED_FIELDS) == required
    assert required <= set(case_aggregate._ANALYST_FIELDS)


class _DocStore:
    """Stored case documents (JSON dicts) read raw, optionally applying the field
    projection itself the way Elasticsearch ``_source`` filtering does."""

    def __init__(self, docs: list[dict[str, Any]], *, project: bool) -> None:
        self.docs = docs
        self.project = project
        self.fields_seen: list[Any] = []

    async def scan_page(self, *, limit: int = 1000, cursor: Any = None, created_from: Any = None,
                        created_to: Any = None, raw: bool = False, statuses: Any = None,
                        fields: Any = None):
        self.fields_seen.append(fields)
        start = int(cursor or 0)
        page = self.docs[start:start + limit]
        if self.project and fields:
            page = [{k: doc[k] for k in fields if k in doc} for doc in page]
        else:
            page = [dict(doc) for doc in page]
        nxt = start + limit if start + limit < len(self.docs) else None
        return page, nxt, len(self.docs), "point_in_time"


def _damaged_docs() -> list[dict[str, Any]]:
    healthy = [c.model_dump(mode="json") for c in _analyst_corpus()]
    by_id = {doc["case_id"]: doc for doc in healthy}
    # A damaged field the analyst outcome never reads: the projection does not carry it.
    by_id["a1"]["trigger_reason"] = "not an object"
    by_id["c5"]["status_history"] = 17
    # A damaged field it does read: that case cannot be graded on any store.
    by_id["c2"]["feedback"] = "not a list"
    return healthy


async def test_a_store_that_ignores_the_projection_folds_exactly_like_one_that_honours_it() -> None:
    """Elasticsearch returns only the projected fields; SQL returns whole documents. The
    fold validates the model from the projected fields either way, so both answer the
    same figures and flag the same unreadable cases."""
    from app.engine.case_aggregate import fold_cases

    spec = CaseAggregateSpec(window=resolve_window("all"), group_by=("rule",), metrics=BREAKDOWN_SPEC_METRICS)
    honours, ignores = _DocStore(_damaged_docs(), project=True), _DocStore(_damaged_docs(), project=False)
    a = await fold_cases(honours, spec)
    b = await fold_cases(ignores, spec)
    assert honours.fields_seen and honours.fields_seen == ignores.fields_seen   # the same hints
    assert a.total == b.total and a.exact == b.exact and a.unreadable == b.unreadable
    assert _rows_of(a, BREAKDOWN_SPEC_METRICS) == _rows_of(b, BREAKDOWN_SPEC_METRICS)


async def test_a_damaged_field_the_analyst_outcome_never_reads_does_not_hide_it() -> None:
    """a1's ``trigger_reason`` and c5's ``status_history`` are damaged: neither is read
    by the analyst outcome, so both are graded and nothing is flagged for them. c2's
    ``feedback`` is damaged: it still counts (its raw fields are readable) but cannot be
    graded, so it lands in ``analyst_ungraded`` and the answer says it is not exact."""
    from app.engine.case_aggregate import fold_cases

    spec = CaseAggregateSpec(window=resolve_window("all"), metrics=BREAKDOWN_SPEC_METRICS)
    result = await fold_cases(_DocStore(_damaged_docs(), project=False), spec)
    totals = result.totals
    assert result.total == len(_analyst_corpus())
    assert (totals["analyst_tp"], totals["analyst_fp"]) == (1, 2)      # c2 lost, a1 and c5 kept
    assert totals["analyst_tp"] + totals["analyst_fp"] + totals["analyst_ungraded"] == result.total
    assert result.unreadable == 1 and result.exact is False


class _RecordingES:
    """Records every search body an Elasticsearch case store sends."""

    def __init__(self) -> None:
        from app.es.fake import InMemoryESClient

        self.client = InMemoryESClient()
        self.bodies: list[dict[str, Any]] = []
        original = self.client.search

        async def search(index: str, body: dict[str, Any]) -> dict[str, Any]:
            self.bodies.append(body)
            return await original(index, body)

        self.client.search = search  # type: ignore[method-assign]


async def test_elasticsearch_transfers_only_the_fields_a_breakdown_reads() -> None:
    from app.constants import CASES_WRITE_ALIAS
    from app.engine import case_aggregate
    from app.engine.case_aggregate import fold_cases
    from app.stores.cases import CaseStore

    recording = _RecordingES()
    for case in _analyst_corpus():
        await recording.client.index_doc(CASES_WRITE_ALIAS, case.model_dump(mode="json"), doc_id=case.case_id)
    store = CaseStore(recording.client)
    spec = CaseAggregateSpec(window=resolve_window("all"), group_by=("rule",), metrics=BREAKDOWN_SPEC_METRICS)
    result = await aggregate_cases(store, spec)
    scans = [b for b in recording.bodies if b.get("size", 0) > 0 and "sort" in b]
    expected = sorted({"case_id", "created_at", "status", "rule_ids", "verdict",
                       *case_aggregate._ANALYST_FIELDS})
    # The fold's pages carry exactly the breakdown's fields; every other read (the open
    # stock, the edges) carries fewer. No read transfers whole case documents.
    assert any(b.get("_source") == {"includes": expected} for b in scans)

    def includes(body: dict[str, Any]) -> set[str] | None:
        source = body.get("_source")
        if isinstance(source, dict):
            return set(source.get("includes") or [])
        return set(source) if isinstance(source, list) else None    # None: whole documents

    assert scans and all((includes(b) or {"<whole document>"}) <= set(expected) for b in scans)
    whole = await fold_cases(store, CaseAggregateSpec(
        window=resolve_window("all"), group_by=("rule",), metrics=BREAKDOWN_SPEC_METRICS + ("mean_risk",)))
    assert _rows_of(result, BREAKDOWN_SPEC_METRICS) == _rows_of(whole, BREAKDOWN_SPEC_METRICS)


# --------------------------------------------------------------------------- #
# 12. Bounded answers, coded parameters, open stock, caption, released stores
# --------------------------------------------------------------------------- #
async def test_a_bucketed_breakdown_over_the_row_budget_is_refused_before_the_read(app_state) -> None:
    """``top`` groups zero-filled across every bucket: 50 rules by hour over 90 days
    would be about 108,000 rows. Refused with advice that fits, before anything is read;
    the widest built-in board query still answers."""
    repo = _CountingRepo(corpus())
    app_state._real_cases = repo  # noqa: SLF001
    response = await _get(app_state, by="rule", bucket="hour", window="now-7d", top=50)
    assert response.status_code == 400
    message = response.json()["detail"]["message"]
    assert re.fullmatch(
        r"This breakdown could return \d+ rows \(50 groups in each of \d+ hour buckets\), more than "
        r"the 5000 one answer holds; use bucket=day, a shorter window or a top of \d+ or fewer",
        message,
    ), message
    assert repo.scans() == 0                                      # nothing was read
    widest = await _breakdown(app_state, by="severity", bucket="day", window="now-90d")
    assert len(widest["buckets"]) >= 90 and len(widest["groups"]) <= 5000
    assert routes_metrics.BREAKDOWN_MAX_ROWS == 5000


async def test_all_time_buckets_count_the_undated_bucket_in_the_row_budget(app_state) -> None:
    await _seed(app_state, corpus())                              # spans 40 days
    refused = await _get(app_state, by="rule", bucket="hour", window="all", top=50)
    assert refused.status_code == 400
    assert "use bucket=day" in refused.json()["detail"]["message"]
    assert (await _get(app_state, by="rule", bucket="day", window="all", top=50)).status_code == 200


async def test_an_answer_over_the_row_budget_is_returned_but_never_kept(app_state, monkeypatch) -> None:
    await _seed(app_state, corpus())

    async def no_precheck(*_a: Any, **_kw: Any) -> None:
        return None

    monkeypatch.setattr(routes_metrics, "_check_bucket_budget", no_precheck)
    monkeypatch.setattr(routes_metrics, "BREAKDOWN_MAX_ROWS", 2)
    body = await _breakdown(app_state, by="rule", window="all", top=50)
    assert len(body["groups"]) > 2
    assert not routes_metrics._breakdown_cache                   # noqa: SLF001
    monkeypatch.setattr(routes_metrics, "BREAKDOWN_MAX_ROWS", 5000)
    await _breakdown(app_state, by="rule", window="all", top=50)
    assert len(routes_metrics._breakdown_cache) == 1              # noqa: SLF001


async def test_top_is_typed_as_an_integer_in_the_contract_and_read_by_the_route(app_state) -> None:
    schema = _api(app_state).openapi()
    params = {p["name"]: p for p in schema["paths"]["/api/metrics/breakdown"]["get"]["parameters"]}
    assert params["top"]["schema"]["type"] == "integer"
    assert params["top"]["schema"]["minimum"] == 1 and params["top"]["schema"]["maximum"] == 50
    assert params["top"]["schema"]["default"] == 10
    await _seed(app_state, corpus())
    assert len((await _breakdown(app_state, by="rule", window="all", top=" 1 "))["groups"]) == 1
    assert (await _breakdown(app_state, by="rule", window="all", top="050"))["other"] is None


async def test_open_now_in_an_unbucketed_row_is_the_stock_and_can_exceed_count(app_state) -> None:
    """Needs human, last 7 days: c3 was created in the window; c6 (40 days old) is still
    open. ``count`` is the windowed cohort (1) and ``open_now`` the open stock (2)."""
    await _seed(app_state, corpus())
    row = _rows(await _breakdown(app_state, by="verdict", window="now-7d"))["NEEDS_HUMAN"]
    assert (row["count"], row["open_now"]) == (1, 2)
    bucketed = await _breakdown(app_state, by="verdict", window="now-7d", bucket="day")
    for group in bucketed["groups"]:
        assert group["open_now"] <= group["count"]               # a bucket's own cohort


async def test_the_window_label_is_a_sentence_case_caption_start(app_state) -> None:
    await _seed(app_state, corpus())
    for window, start in (("now-7d", "Last 7 days"), ("all", "All time"), ("now-24h", "Last 24 hours")):
        label = (await _breakdown(app_state, by="severity", window=window))["window_label"]
        assert label.startswith(start), (window, label)
    usage = await _breakdown(app_state, kind="usage", by="surface", window="now-7d")
    assert usage["window_label"].startswith("Last 7 days")


async def test_expired_answers_are_released_by_the_next_request(app_state, monkeypatch) -> None:
    await _seed(app_state, corpus())
    clock = {"now": 1000.0}
    monkeypatch.setattr(routes_metrics, "_monotonic", lambda: clock["now"])
    await _breakdown(app_state, by="rule", window="all")
    assert len(routes_metrics._breakdown_cache) == 1             # noqa: SLF001
    clock["now"] += routes_metrics.BREAKDOWN_CACHE_TTL_SECONDS + 1

    async def boom(**_kw: Any) -> Any:
        raise RuntimeError("store down")

    monkeypatch.setattr(app_state.cases, "scan_page", boom)
    assert (await _get(app_state, by="verdict", window="all")).status_code == 503
    assert not routes_metrics._breakdown_cache                   # noqa: SLF001 - released, not kept


async def test_a_demo_store_is_never_kept_alive_after_demo_mode_ends(app_state) -> None:
    await _seed(app_state, corpus())
    await app_state.enable_demo(mode="seeded", seed=7, history_days=14)
    try:
        demo_cases, demo_usage = app_state.cases, app_state.usage_store
        await _breakdown(app_state, by="verdict", window="all")
        await _breakdown(app_state, kind="usage", by="surface", window="all")
        assert any(e.store in (demo_cases, demo_usage) for e in routes_metrics._breakdown_cache.values())  # noqa: SLF001
    finally:
        await app_state.disable_demo()
    await _breakdown(app_state, by="severity", window="all")
    entries = list(routes_metrics._breakdown_cache.values())     # noqa: SLF001
    assert entries and not any(e.store is demo_cases or e.store is demo_usage for e in entries)


_MONTH_ABBR = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")


def _since(window_from: str, zone: str = "UTC") -> str:
    """The "since" part a caption states for a rolling window starting at ``window_from``,
    written independently of the route: "21 Oct 2026, 12:00" (", <zone>" when not UTC)."""
    from zoneinfo import ZoneInfo

    local = datetime.fromisoformat(window_from).astimezone(ZoneInfo(zone))
    text = f"{local.day} {_MONTH_ABBR[local.month - 1]} {local.year}, {local.hour:02d}:{local.minute:02d}"
    return text if zone == "UTC" else f"{text}, {zone}"


@pytest.mark.parametrize(("hours", "name"), [
    (24, "Last 24 hours"), (168, "Last 7 days"), (720, "Last 30 days"), (2160, "Last 90 days"),
])
async def test_a_board_hours_window_reads_like_the_board_preset(app_state, hours, name) -> None:
    """A board sends its windows as hours tokens (``now-168h``) so its breakdowns count
    the span its posture figures count; the caption that starts with ``window_label``
    must still read "Last 7 days", never "Last 168 hours", and say where it starts."""
    await _seed(app_state, corpus())
    body = await _breakdown(app_state, by="severity", window=f"now-{hours}h")
    assert body["window_label"] == f"{name} (since {_since(body['window_from'])})"
    start = datetime.fromisoformat(body["window_from"])
    assert abs((datetime.now(UTC) - start) - timedelta(hours=hours)) < timedelta(minutes=5)
    bucketed = await _breakdown(app_state, by="severity", bucket="day", window=f"now-{hours}h")
    assert bucketed["window_label"] == body["window_label"]
    usage = await _breakdown(app_state, kind="usage", by="surface", window=f"now-{hours}h")
    assert usage["window_label"] == f"{name} (since {_since(usage['window_from'])})"


async def test_the_board_label_changes_no_number(app_state) -> None:
    """Only the label changes: ``now-168h`` still counts the rolling 168 hours (c5, 30
    hours old, is in; c6, 40 days old, is out), exactly what the engine counts for it."""
    await _seed(app_state, corpus())
    body = await _breakdown(app_state, by="verdict", window="now-168h")
    resolved = resolve_window("now-168h", tz="UTC", now=datetime.now(UTC))
    engine = await aggregate_cases(app_state.cases, CaseAggregateSpec(
        window=resolved, group_by=("verdict",), metrics=("count",), prefs=app_state.execution_prefs,
    ))
    assert engine.window_label == "last 168 hours"                 # the engine's own words
    assert body["total"] == engine.total
    assert {g["key"]: g["count"] for g in body["groups"]} == {
        (row["key"] or {}).get("verdict"): row["metrics"]["count"] for row in engine.groups if not row.get("other")
    }


@pytest.mark.parametrize(("window", "name"), [
    ("now-1h", "Last 1 hour"), ("now-36h", "Last 36 hours"), ("now-48h", "Last 2 days"),
    ("now-2161h", "Last 2,161 hours"), ("past 24 hours", "Last 24 hours"),
])
async def test_other_hours_windows_name_their_span_and_start(app_state, window, name) -> None:
    await _seed(app_state, corpus())
    body = await _breakdown(app_state, by="severity", window=window)
    assert body["window_label"] == f"{name} (since {_since(body['window_from'])})"


async def test_an_hours_window_states_its_start_in_the_operator_zone(app_state) -> None:
    app_state.prefs.sla.timezone = "Asia/Kolkata"
    await _seed(app_state, corpus())
    body = await _breakdown(app_state, by="severity", window="now-168h")
    assert body["window_label"] == f"Last 7 days (since {_since(body['window_from'], 'Asia/Kolkata')})"
    assert body["window_label"].endswith(", Asia/Kolkata)")


async def test_day_and_minute_windows_keep_the_engine_label(app_state) -> None:
    """``now-7d`` keeps chat's whole-day meaning and wording, and a minutes window is not
    an hours token: neither is relabelled."""
    await _seed(app_state, corpus())
    days = await _breakdown(app_state, by="severity", window="now-7d")
    assert re.fullmatch(r"Last 7 days \(since \d{1,2} [A-Z][a-z]{2} \d{4}\)", days["window_label"])
    minutes = await _breakdown(app_state, by="severity", window="now-90m")
    assert minutes["window_label"] == "Last 90 minutes"


def _sized_answer(rows: int) -> MetricsBreakdown:
    return MetricsBreakdown(by="rule", groups=[MetricsBreakdownGroup(key=f"r{i}", count=1) for i in range(rows)])


def test_the_default_row_bound_holds_four_of_the_largest_answers() -> None:
    assert routes_metrics.BREAKDOWN_CACHE_MAX_ROWS >= 4 * routes_metrics.BREAKDOWN_MAX_ROWS


async def test_the_shared_answers_never_hold_more_than_the_row_bound(app_state, monkeypatch) -> None:
    """Varying the window text (``now-30h``, ``now-31h``, ...) makes every request a new
    question; the shared answers still never weigh more than the row bound, the oldest
    go first and the newest answer is always kept."""
    await _seed(app_state, corpus())
    first = await _breakdown(app_state, by="severity", bucket="hour", window="now-30h")
    per_answer = len(first["groups"])
    assert per_answer > 10                                    # a large answer, zero-filled
    bound = 3 * per_answer + per_answer // 2
    monkeypatch.setattr(routes_metrics, "BREAKDOWN_CACHE_MAX_ROWS", bound)
    invalidate_breakdown_cache()
    windows = [f"now-{hours}h" for hours in range(30, 42)]
    for window in windows:
        body = await _breakdown(app_state, by="severity", bucket="hour", window=window)
        cache = routes_metrics._breakdown_cache                   # noqa: SLF001
        assert sum(entry.rows for entry in cache.values()) <= bound
        newest_key, newest = list(cache.items())[-1]
        assert newest_key[9] == window and newest.value.model_dump(mode="json") == body
    kept = [key[9] for key in routes_metrics._breakdown_cache]   # noqa: SLF001
    assert kept == windows[-len(kept):] and len(kept) < len(windows)


async def test_a_refreshed_answer_counts_as_the_newest(monkeypatch) -> None:
    """An answer read again for a key already held (here: the key's store changed) is
    re-inserted, so the row bound evicts the answers nobody asked for since, not it."""
    monkeypatch.setattr(routes_metrics, "BREAKDOWN_CACHE_MAX_ROWS", 25)
    store_a, store_b = object(), object()

    def read(rows: int) -> Any:
        async def compute() -> tuple[MetricsBreakdown, bool]:
            return _sized_answer(rows), True
        return compute

    shared = routes_metrics._shared_breakdown                    # noqa: SLF001
    await shared(("one",), store_a, read(10))
    await shared(("two",), store_a, read(10))
    await shared(("one",), store_b, read(10))                  # read again, now the newest
    assert list(routes_metrics._breakdown_cache) == [("two",), ("one",)]   # noqa: SLF001
    await shared(("three",), store_a, read(10))                # 30 rows: "two" goes first
    assert list(routes_metrics._breakdown_cache) == [("one",), ("three",)]  # noqa: SLF001
    assert routes_metrics._breakdown_cache[("one",)].store is store_b       # noqa: SLF001


async def test_an_answer_larger_than_the_whole_bound_is_served_but_not_kept(monkeypatch) -> None:
    monkeypatch.setattr(routes_metrics, "BREAKDOWN_CACHE_MAX_ROWS", 5)
    held = object()

    async def compute() -> tuple[MetricsBreakdown, bool]:
        return _sized_answer(8), True

    value = await routes_metrics._shared_breakdown(("big",), held, compute)  # noqa: SLF001
    assert len(value.groups) == 8
    assert not routes_metrics._breakdown_cache                   # noqa: SLF001


# --------------------------------------------------------------------------- #
# 13. Chat names what to ask for when the engine refuses the request
# --------------------------------------------------------------------------- #
async def test_chat_still_names_what_to_ask_for_when_the_request_is_refused(app_state, monkeypatch) -> None:
    from app.engine import case_aggregate

    await _seed(app_state, corpus())
    ctx = make_ctx(cases=app_state.cases, prefs=app_state.execution_prefs)

    async def refuse(*_a: Any, **_kw: Any) -> Any:
        raise case_aggregate.AggregateRequestError("Unknown metric(s) ['x']; use count")

    monkeypatch.setattr("app.agents.chat_tools.stats.run_case_aggregate", refuse)
    out = await CaseStatsTool().run(ctx, group_by=["rule"])
    assert not out.ok and str(out.error).startswith("Invalid input: Unknown metric")
