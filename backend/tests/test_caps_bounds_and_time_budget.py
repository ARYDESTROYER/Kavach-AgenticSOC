"""Item A — per-case caps that cannot destroy the operator's configuration, plus the
case TIME budget that bounds one model request by the time the case actually has left.

Three things are pinned here:

1. **Bounds + repair.** ``CapsConfig`` now declares ``ge=1`` on its numeric caps (0 and
   negatives categorically cannot work). The bound alone would have been a *regression*:
   both preference loaders answer any validation error by catching a bare ``Exception``
   and returning a FULL DEFAULT ``Preferences()`` — and ``Preferences`` is ONE document
   that also carries ``auto_close`` (the policy ``decide()`` consumes), ``rule_catalog``
   and ``sources``. So a clamping ``before`` validator REPAIRS an out-of-range stored
   value, and the headline test asserts the rest of the stored configuration survives.
2. **The time axis on ``CaseBudget``.** Stamped at the ``asyncio.wait_for`` site (never at
   construction), it exposes ``remaining()``/``request_timeout()``/``time_exhausted()``.
   Unstamped, every accessor is ``None``/False and the budget behaves exactly as before.
3. **The cooperative stop.** The ReAct loop now ends on the time budget one reserved
   per-request slice EARLY, instead of being cancelled outright by the outer
   ``wait_for``. The DECISION is unchanged — the draft is still ``None``, so it is the
   same NEEDS_HUMAN as before (a forced final verdict is explicitly out of scope). What
   it buys is that the accumulated reasoning reaches the VERDICT audit row and the spend
   lands through the normal return path.

Offline throughout (fake ES + mock LLM); the clock is injected so nothing sleeps.
"""

from __future__ import annotations

import asyncio
import json

import pytest
from pydantic import ValidationError

from app.audit.audit_log import AuditLogger
from app.agents.formatter import Formatter
from app.agents.investigator import Investigator
from app.config import CAPS_MINIMUMS, CapsConfig, Preferences, SourceInstance
from app.constants import EntityType, Role, SourceType, UsageOutcome, Verdict
from app.engine.correlation import cluster_from_events
from app.engine.cost_gate import CaseBudget
from app.es.fake import InMemoryESClient
from app.llm.gateway import (
    FAILURE_ABANDONED,
    PROVIDER_FAILURE_CLASSES,
    LLMGateway,
)
from app.llm.providers import MockProvider
from app.stores.config_store import ConfigStore
from app.stores.usage import USAGE_READ_PATTERN, UsageStore
from app.tools.base import ToolRegistry
from app.config import Secrets

from tests.conftest import make_raw_event


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def _configured_prefs() -> Preferences:
    """A Preferences that carries real operator intent in the fields a naive
    "reject the document" bound would have silently reverted."""
    prefs = Preferences()
    prefs.setup_complete = True
    prefs.data_view_pattern = "acme-logs-*"
    prefs.sources = [
        SourceInstance(id="src-a", name="Primary", source_type=SourceType.ELASTICSEARCH, enabled=True),
    ]
    prefs.maybe_seed_rule_catalog()
    # Operator intent on the policy decide() consumes.
    prefs.auto_close.false_positive.enabled = True
    prefs.auto_close.false_positive.min_confidence = 0.97
    prefs.auto_close.false_positive.max_risk_score = 12.0
    return prefs


def _cluster(ip: str = "203.0.113.77", rule: str = "sshd", n: int = 3):
    base = 1_700_000_000_000
    events = [
        make_raw_event(id=f"e{i}", ip=ip, rule=rule, ts_millis=base + i * 1000)
        for i in range(n)
    ]
    return cluster_from_events(EntityType.IP, ip, events)


def _tool_action() -> str:
    return json.dumps({"action": "tool", "tool": "noop", "input": {}})


class _NoopTool:
    name = "noop"
    description = "does nothing"
    input_schema: dict = {"type": "object", "properties": {}}

    def __init__(self) -> None:
        from app.constants import ToolTier

        self.tier = ToolTier.SAFE

    def definition(self) -> dict:
        return {"name": self.name, "description": self.description,
                "input_schema": self.input_schema}

    async def run(self, **kwargs):
        from app.tools.base import ToolResult

        return ToolResult(ok=True, summary="noop")


def _build_investigator(es: InMemoryESClient, provider: MockProvider):
    gw = LLMGateway(
        Secrets(_env_file=None), UsageStore(es),
        provider_overrides={"anthropic": provider, "openai": provider, "mock": provider},
    )
    audit = AuditLogger(es)
    records: list[dict] = []
    original = audit.record

    async def _record(**kwargs):
        records.append(kwargs)
        return await original(**kwargs)

    audit.record = _record  # type: ignore[method-assign]
    inv = Investigator(gw, ToolRegistry([_NoopTool()]), audit, Formatter(gw, audit))
    return inv, records


# --------------------------------------------------------------------------- #
# 1. THE HEADLINE: an out-of-range stored cap must not revert the whole document.
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_stored_zero_timeout_keeps_sources_rule_catalog_and_auto_close() -> None:
    """A persisted document holding ``caps.timeout_seconds = 0`` round-trips through the
    real loader WITH its sources, rule catalog and auto-close policy INTACT.

    That is the whole point of the repair path: without it, the new ``ge=1`` bound would
    make ``ConfigStore.load`` fall into its bare-``except`` and return defaults, silently
    reverting the close policy ``decide()`` consumes for every deployer already holding
    an out-of-range value — behind a single log line no UI surfaces."""
    es = InMemoryESClient()
    store = ConfigStore(es)
    stored = _configured_prefs()
    assert stored.rule_catalog, "fixture must carry a seeded rule catalog"
    doc = stored.model_dump(mode="json")
    doc["caps"]["timeout_seconds"] = 0  # the poisoned value

    from app.constants import CONFIG_DOC_ID, CONFIG_INDEX

    await es.index_doc(CONFIG_INDEX, doc, doc_id=CONFIG_DOC_ID, refresh=True)
    loaded = await store.load()

    # The cap itself is repaired up to its floor...
    assert loaded.caps.timeout_seconds == CAPS_MINIMUMS["timeout_seconds"] == 1
    # ...and NOTHING ELSE was lost.
    assert [s.id for s in loaded.sources] == ["src-a"]
    assert len(loaded.rule_catalog) == len(stored.rule_catalog)
    assert loaded.auto_close.false_positive.enabled is True
    assert loaded.auto_close.false_positive.min_confidence == 0.97
    assert loaded.auto_close.false_positive.max_risk_score == 12.0
    assert loaded.data_view_pattern == "acme-logs-*"
    assert loaded.setup_complete is True


def test_every_declared_caps_floor_is_repaired_not_rejected() -> None:
    """Each ``ge`` floor read back off ``CapsConfig`` is clamped, not raised on."""
    assert set(CAPS_MINIMUMS) >= {
        "max_tool_calls", "max_tokens", "timeout_seconds", "request_timeout_seconds",
    }
    doc = Preferences().model_dump(mode="json")
    for key in CAPS_MINIMUMS:
        doc["caps"][key] = -7
    repaired = Preferences.model_validate(doc)
    for key, floor in CAPS_MINIMUMS.items():
        assert getattr(repaired.caps, key) == floor


def test_clamp_leaves_in_range_values_untouched() -> None:
    doc = Preferences().model_dump(mode="json")
    doc["caps"]["max_tool_calls"] = 40
    doc["caps"]["timeout_seconds"] = 900
    prefs = Preferences.model_validate(doc)
    assert prefs.caps.max_tool_calls == 40
    assert prefs.caps.timeout_seconds == 900


def test_clamp_is_a_noop_without_a_caps_block() -> None:
    """#5: an absent config block makes the new behaviour a no-op."""
    prefs = Preferences.model_validate({"data_view_pattern": "x-*"})
    assert prefs.caps.timeout_seconds == CapsConfig().timeout_seconds
    assert prefs.data_view_pattern == "x-*"


def test_clamp_is_not_gated_on_the_persisted_config_markers() -> None:
    """Unlike the autopilot migration, the clamp must also repair a targeted
    programmatic construction — that is exactly where an internal caller or a test
    would otherwise hit the new hard failure."""
    prefs = Preferences.model_validate({"caps": {"max_tokens": 0}})
    assert prefs.caps.max_tokens == 1


def test_non_numeric_cap_is_left_for_normal_field_validation() -> None:
    with pytest.raises(ValidationError):
        Preferences.model_validate({"caps": {"max_tokens": "plenty"}})


def test_capsconfig_itself_still_rejects_an_out_of_range_value() -> None:
    """The bound is real; only ALREADY-STORED documents get the repair."""
    for key in ("max_tool_calls", "max_tokens", "timeout_seconds", "request_timeout_seconds"):
        with pytest.raises(ValidationError):
            CapsConfig(**{key: 0})


def test_there_is_no_upper_bound_on_the_caps() -> None:
    """An upper bound would encode one vendor's hosted-API envelope as product policy
    and would revert the config of any deployer already above it (§6 agnosticism)."""
    caps = CapsConfig(max_tool_calls=10_000, max_tokens=100_000_000, timeout_seconds=86_400,
                      request_timeout_seconds=86_400)
    assert caps.max_tokens == 100_000_000
    assert caps.timeout_seconds == 86_400


# --------------------------------------------------------------------------- #
# 2. CaseBudget time axis — deterministic, injected clock.
# --------------------------------------------------------------------------- #
def test_unstamped_budget_is_byte_for_byte_the_previous_behaviour() -> None:
    budget = CaseBudget(CapsConfig())
    assert budget.remaining() is None
    assert budget.request_timeout() is None
    assert budget.time_exhausted() is False
    assert budget.exceeded() is False
    assert budget.capped_reason is None


def test_start_stamps_a_deadline_and_bounds_one_request() -> None:
    now = [0.0]
    budget = CaseBudget(CapsConfig(), clock=lambda: now[0])
    budget.start(timeout_seconds=120, request_timeout_seconds=60)
    # Reserve = FORMATTER_RESERVE_FRACTION of the span (0.15 x 120 = 18), clamped by the
    # configured per-request timeout (60) — so 18, not 60.
    assert budget.remaining() == 120.0
    assert budget.request_timeout() == 60.0
    assert budget.time_exhausted() is False

    now[0] = 90.0  # 30s left: still 12s of usable budget outside the reserve
    assert budget.remaining() == 30.0
    assert budget.request_timeout() == pytest.approx(12.0)
    assert budget.time_exhausted() is False

    now[0] = 102.0  # 18s left == the reserve -> stop cooperatively
    assert budget.request_timeout() == 0.0
    assert budget.time_exhausted() is True
    assert "case time budget exhausted" in (budget.capped_reason or "")


def test_the_reserve_is_a_small_fraction_never_half_the_case_budget() -> None:
    """THE REGRESSION. ``min(request_timeout_seconds, span/2)`` bound EXACTLY at the
    shipped defaults (``min(60, 60)``), so the "clamp" was the operating point and half
    of every operator-configured 120s timeout was unreachable: the ReAct loop stopped at
    t=60s and runs that used to produce a real verdict returned NEEDS_HUMAN instead.

    The reserve is ONE SHORT formatter call's share of the case, not one whole
    per-request slice."""
    for span in (10, 60, 120, 200, 600):
        now = [0.0]
        budget = CaseBudget(CapsConfig(), clock=lambda: now[0])
        budget.start(timeout_seconds=span, request_timeout_seconds=60)
        now[0] = span / 2.0
        assert budget.time_exhausted() is False, (
            f"half of a {span}s case budget must still be usable"
        )
        # And it is never MORE than the configured per-request timeout.
        assert budget.request_timeout() is not None
        assert budget.request_timeout() <= 60.0


def test_per_request_bound_is_the_min_of_config_and_time_left() -> None:
    now = [0.0]
    budget = CaseBudget(CapsConfig(), clock=lambda: now[0])
    # A per-case cap SMALLER than one retry ladder: the request bound must shrink to
    # the time actually left rather than let one call consume the whole case.
    budget.start(timeout_seconds=30, request_timeout_seconds=60)
    # 30 - reserve(min(60, 0.15 x 30) = 4.5) = 25.5
    assert budget.request_timeout() == pytest.approx(25.5)
    now[0] = 10.0
    assert budget.request_timeout() == pytest.approx(15.5)


def test_reserve_stays_proportional_on_a_tiny_case_budget() -> None:
    """Existing deployments/tests deliberately set ``timeout_seconds=1``; the reserve
    must never swallow the entire budget before a single model call is attempted."""
    now = [0.0]
    budget = CaseBudget(CapsConfig(), clock=lambda: now[0])
    budget.start(timeout_seconds=1, request_timeout_seconds=60)
    assert budget.time_exhausted() is False
    assert budget.request_timeout() == pytest.approx(0.85)


def test_the_loop_will_not_start_a_request_it_has_decided_it_cannot_wait_for() -> None:
    """The slice decays toward the reserve, so without a floor the loop dispatches a
    request under an arbitrarily small deadline, cancels it mid-flight, and gets nothing
    for the provider spend. The floor is measured, not guessed: the longest request THIS
    case has already completed."""
    now = [0.0]
    budget = CaseBudget(CapsConfig(), clock=lambda: now[0])
    budget.start(timeout_seconds=120, request_timeout_seconds=60)

    # No completed request yet -> no evidence -> never gate the first call.
    now[0] = 101.0
    assert budget.time_exhausted() is False

    # One request completes, taking 20s.
    now[0] = 0.0
    started = budget.request_started()
    now[0] = 20.0
    budget.note_request(started)

    now[0] = 60.0  # 60 left, 18 reserved -> 42s usable, comfortably above 20
    assert budget.time_exhausted() is False
    now[0] = 90.0  # 30 left, 18 reserved -> 12s usable, BELOW the 20s a call needs
    assert budget.time_exhausted() is True
    assert "longest model request" in (budget.capped_reason or "")


def test_start_with_no_timeout_leaves_the_budget_unstamped() -> None:
    budget = CaseBudget(CapsConfig())
    budget.start(timeout_seconds=0, request_timeout_seconds=60)
    assert budget.remaining() is None
    assert budget.time_exhausted() is False
    # Only the configured per-request bound survives; the case has no deadline.
    assert budget.request_timeout() == 60.0


def test_remaining_never_goes_negative() -> None:
    now = [0.0]
    budget = CaseBudget(CapsConfig(), clock=lambda: now[0])
    budget.start(timeout_seconds=5, request_timeout_seconds=1)
    now[0] = 500.0
    assert budget.remaining() == 0.0
    assert budget.request_timeout() == 0.0


# --------------------------------------------------------------------------- #
# 3. The ReAct loop stops cooperatively on the time budget.
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_react_loop_stops_on_the_time_budget_and_keeps_its_reasoning() -> None:
    """The loop ends on the case deadline instead of being cancelled outright.

    TRUTHFULLY: the draft is still ``None``, so the verdict is the SAME NEEDS_HUMAN as
    a hard cancellation would have produced. What is new is that the ``[capped]``
    explanation reaches the VERDICT audit row and the realised spend is returned on the
    normal path rather than reconstructed from the timeout side-channel."""
    now = [0.0]
    es = InMemoryESClient()
    provider = MockProvider()
    inv, records = _build_investigator(es, provider)

    # One tool step, then the clock jumps past the reserve so the next iteration stops.
    provider.push("investigator", _tool_action())
    original_complete = provider.complete

    async def _complete(role, messages, model, temperature, max_tokens):
        result = await original_complete(role, messages, model, temperature, max_tokens)
        if role == "investigator":
            now[0] += 100.0  # 120s budget, 60s reserve -> 20s left -> exhausted
        return result

    provider.complete = _complete  # type: ignore[method-assign]

    prefs = Preferences()
    budget = CaseBudget(prefs.caps, clock=lambda: now[0])
    budget.start(timeout_seconds=prefs.caps.timeout_seconds,
                 request_timeout_seconds=prefs.caps.request_timeout_seconds)

    verdict, cost = await inv.investigate(
        _cluster(), None, None, prefs, budget, surface="investigate", case_id="case-0001",
    )

    assert verdict.verdict == Verdict.NEEDS_HUMAN  # unchanged decision (#3)
    assert cost >= 0.0
    verdict_rows = [r for r in records if r.get("action_type").value == "verdict"]
    assert verdict_rows, "the run must still reach the VERDICT audit row"
    summary = verdict_rows[-1]["result_summary"]
    assert "capped" in summary and "case time budget exhausted" in summary


@pytest.mark.asyncio
async def test_one_slow_request_is_bounded_by_its_slice_of_the_case_budget() -> None:
    """A single degraded completion can no longer consume the whole case budget: it is
    cut at ``min(request_timeout_seconds, time left)`` and the loop stops cooperatively,
    so the partial reasoning survives into the audit row."""
    es = InMemoryESClient()
    provider = MockProvider()
    inv, records = _build_investigator(es, provider)

    provider.push("investigator", _tool_action())
    original_complete = provider.complete
    calls = {"n": 0}

    async def _complete(role, messages, model, temperature, max_tokens):
        if role == "investigator":
            calls["n"] += 1
            if calls["n"] >= 2:
                await asyncio.sleep(30)  # never completes inside its slice
        return await original_complete(role, messages, model, temperature, max_tokens)

    provider.complete = _complete  # type: ignore[method-assign]

    prefs = Preferences()
    budget = CaseBudget(prefs.caps)
    # A 1s case cap with a 1s per-request cap -> 0.5s reserve, 0.5s usable slice.
    budget.start(timeout_seconds=1, request_timeout_seconds=1)

    verdict, _cost = await asyncio.wait_for(
        inv.investigate(_cluster(), None, None, prefs, budget,
                        surface="investigate", case_id="case-0002"),
        timeout=10,
    )

    assert verdict.verdict == Verdict.NEEDS_HUMAN
    verdict_rows = [r for r in records if r.get("action_type").value == "verdict"]
    assert verdict_rows, "the run must still reach the VERDICT audit row"
    assert "capped" in verdict_rows[-1]["result_summary"]


@pytest.mark.asyncio
async def test_an_unstamped_budget_leaves_the_loop_completely_unbounded() -> None:
    """#5 again, at the loop: with no deadline stamped there is no per-request
    ``wait_for`` at all, so the pre-change behaviour is preserved exactly."""
    es = InMemoryESClient()
    provider = MockProvider()
    inv, _records = _build_investigator(es, provider)
    provider.push("investigator", json.dumps({
        "action": "final", "reasoning": "done",
        "verdict": {"verdict": "FALSE_POSITIVE", "confidence": 0.9, "evidence": [],
                    "mitre": [], "recommended_action": "close", "reproduce_query": ""},
    }))
    prefs = Preferences()
    budget = CaseBudget(prefs.caps)  # never started
    verdict, _cost = await inv.investigate(
        _cluster(), None, None, prefs, budget, surface="investigate", case_id="case-0003",
    )
    assert verdict.verdict == Verdict.FALSE_POSITIVE


@pytest.mark.asyncio
async def test_a_case_that_needs_more_than_half_the_budget_still_reaches_a_verdict() -> None:
    """THE REGRESSION, end to end and at the SHIPPED defaults.

    With the reserve pinned at one whole per-request slice it was exactly half the 120s
    case budget, so an investigation whose model calls occupied 60-120s was cut off with
    ``draft = None`` and returned NEEDS_HUMAN — a real verdict downgraded to a human
    queue item, with no configuration change and half the operator's timeout unspent.
    Nine 9-second calls (81s, comfortably inside the configured 120s) must produce the
    verdict the model actually reached."""
    now = [0.0]
    es = InMemoryESClient()
    provider = MockProvider()
    inv, _records = _build_investigator(es, provider)

    for _ in range(8):
        provider.push("investigator", _tool_action())
    provider.push("investigator", json.dumps({
        "action": "final", "reasoning": "known-benign scheduled scanner",
        "verdict": {"verdict": "FALSE_POSITIVE", "confidence": 0.95, "evidence": [],
                    "mitre": [], "recommended_action": "close", "reproduce_query": ""},
    }))
    original_complete = provider.complete

    async def _complete(role, messages, model, temperature, max_tokens):
        result = await original_complete(role, messages, model, temperature, max_tokens)
        if role == "investigator":
            now[0] += 9.0
        return result

    provider.complete = _complete  # type: ignore[method-assign]

    prefs = Preferences()
    assert (prefs.caps.timeout_seconds, prefs.caps.request_timeout_seconds) == (120, 60)
    budget = CaseBudget(prefs.caps, clock=lambda: now[0])
    budget.start(timeout_seconds=prefs.caps.timeout_seconds,
                 request_timeout_seconds=prefs.caps.request_timeout_seconds)

    verdict, _cost = await inv.investigate(
        _cluster(), None, None, prefs, budget, surface="investigate", case_id="case-0004",
    )

    assert verdict.verdict == Verdict.FALSE_POSITIVE
    assert budget.capped_reason is None
    assert now[0] == pytest.approx(81.0)


@pytest.mark.asyncio
async def test_an_abandoned_request_still_reaches_the_usage_ledger() -> None:
    """#6: 100% of LLM calls reach the ledger. A request that was ISSUED and then
    cancelled (its slice of the case budget elapsed) may still be billed by the provider,
    so it must produce exactly one row. ``asyncio.CancelledError`` is a ``BaseException``,
    so the gateway's ``except Exception`` never saw it and the row was simply lost."""
    es = InMemoryESClient()
    provider = MockProvider()
    gw = LLMGateway(
        Secrets(_env_file=None), UsageStore(es),
        provider_overrides={"anthropic": provider, "openai": provider, "mock": provider},
    )
    original_complete = provider.complete

    async def _complete(role, messages, model, temperature, max_tokens):
        await asyncio.sleep(30)  # never finishes inside the slice below
        return await original_complete(role, messages, model, temperature, max_tokens)

    provider.complete = _complete  # type: ignore[method-assign]

    prefs = Preferences()
    with pytest.raises(asyncio.TimeoutError):
        await asyncio.wait_for(
            gw.complete(Role.INVESTIGATOR, [{"role": "user", "content": "hi"}],
                        prefs.model_for(Role.INVESTIGATOR), surface="investigate",
                        case_id="case-0005"),
            timeout=0.05,
        )

    resp = await es.search(USAGE_READ_PATTERN, {"size": 50, "query": {"match_all": {}}})
    rows = [hit["_source"] for hit in resp["hits"]["hits"]]
    assert len(rows) == 1, rows
    assert rows[0]["outcome"] == UsageOutcome.ERROR.value
    assert rows[0]["failure_class"] == FAILURE_ABANDONED
    # An abandoned call is OUR decision, not evidence about the provider, so it must
    # stay outside the closed provider-failure vocabulary the breaker consumes.
    assert FAILURE_ABANDONED not in PROVIDER_FAILURE_CLASSES


# --------------------------------------------------------------------------- #
# 4. The REQUEST-BODY rejection (a stored document is still repaired, not rejected).
# --------------------------------------------------------------------------- #
def test_a_below_floor_cap_in_a_settings_put_is_rejected_not_laundered(client) -> None:
    """``_clamp_caps`` is a ``before`` validator, so the ``ge=`` constraints could never
    fire for a REQUEST BODY: the endpoint answered 200 and stored a value the operator
    never typed — and ``timeout_seconds=1`` is exactly as unusable as the 0 they meant to
    reject. The sibling ``resilience`` block was rejected by its own field constraints,
    so the surface was inconsistent as well as silent."""
    before = client.get("/api/settings").json()["prefs"]["caps"]
    for key, bad in (("timeout_seconds", 0), ("max_tokens", -5),
                     ("max_tool_calls", 0), ("request_timeout_seconds", -1)):
        resp = client.put("/api/settings", json={"caps": {key: bad}})
        assert resp.status_code == 422, (key, resp.json())
        assert f"caps.{key}" in resp.json()["detail"]
    assert client.get("/api/settings").json()["prefs"]["caps"] == before


def test_an_in_range_caps_put_still_saves(client) -> None:
    resp = client.put("/api/settings", json={"caps": {"timeout_seconds": 240}})
    assert resp.status_code == 200
    assert resp.json()["prefs"]["caps"]["timeout_seconds"] == 240


def test_the_settings_schema_publishes_the_floor_it_now_enforces(client) -> None:
    """Without it the schema-driven "Advanced (all settings)" renderer — the only surface
    some sections have — offered an unbounded integer for a field the API rejects."""
    sections = client.get("/api/settings/schema").json()["sections"]
    caps = next(s for s in sections if s["key"] == "caps")
    for field in caps["fields"]:
        if field["name"] in CAPS_MINIMUMS:
            assert field["minimum"] == CAPS_MINIMUMS[field["name"]]
    # A field that declares no bound still carries no bound key (byte-identical).
    kill = next(f for f in caps["fields"] if f["name"] == "kill_switch")
    assert "minimum" not in kill and "maximum" not in kill
