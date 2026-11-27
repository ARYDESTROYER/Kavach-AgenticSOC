"""Round 12 (SPEC D5): chat and the daily AI budget.

Chat is not blocked by the daily AI budget and its spend does not count toward it, so
chat can neither be paused by investigations' spend nor push investigations to
NEEDS_HUMAN. Every chat call is still metered by the one gateway (#6). An optional chat
daily cap (``chat_agent.chat_daily_cap_usd``, off by default) gives the budget notice.
Investigations keep the pipeline backstop (#10)."""

from __future__ import annotations

import inspect
from datetime import timedelta
from typing import Any

import pytest

from app.agents.chat import TurnOutcome
from app.agents.chat_protocol import NOTICE_MESSAGES
from app.config import BudgetConfig, ChatAgentConfig, ModelConfig, Preferences, Secrets
from app.constants import USAGE_READ_PATTERN, Role
from app.engine import budget as budget_module
from app.engine.budget import EXCLUDED_SURFACES, BudgetGate
from app.es.fake import InMemoryESClient
from app.llm import gateway as gateway_module
from app.llm.gateway import BUDGET_EXEMPT_SURFACES, BudgetBlocked, LLMGateway, budget_exempt
from app.llm.providers import BaseProvider, CompletionResult
from app.models import UsageDoc
from app.stores.usage import UsageStore
from app.utils import now_utc
from tests.test_chat_engine_loop import FakeGateway, final, make_ctx, make_engine

MESSAGES = [{"role": "user", "content": "hello"}]
NOON = now_utc().replace(hour=12, minute=0, second=0, microsecond=0)


class OkProvider(BaseProvider):
    async def complete(self, role, messages, model, temperature, max_tokens) -> CompletionResult:
        return CompletionResult(text='{"action": "final"}\n---ANSWER---\nok', prompt_tokens=100,
                                completion_tokens=10, model=model, finish_reason="stop")

    async def aclose(self) -> None:
        return None


@pytest.fixture(autouse=True)
def fixed_noon(monkeypatch: pytest.MonkeyPatch):
    """One shared clock for the ledger and the gate (a run crossing 00:00 UTC must not
    move rows into yesterday between setup and assertion)."""
    monkeypatch.setattr("app.stores.usage.now_utc", lambda: NOON)
    monkeypatch.setattr(budget_module, "now_utc", lambda: NOON)
    yield


async def _ledger(es: InMemoryESClient, *rows: tuple[str, str, float, int]) -> UsageStore:
    """Write ``(surface, role, cost, minutes_ago)`` rows to a real usage ledger."""
    store = UsageStore(es)
    for surface, role, cost, minutes_ago in rows:
        ts = (NOON - timedelta(minutes=minutes_ago)).isoformat()
        await store.write(UsageDoc(ts=ts, surface=surface, role=role, model="gpt-4o", cost=cost,
                                   prompt_tokens=10, completion_tokens=10, total_tokens=20))
    return store


async def _usage_docs(es: InMemoryESClient) -> list[dict[str, Any]]:
    resp = await es.search(USAGE_READ_PATTERN, {"size": 1000, "query": {"match_all": {}}})
    return [h["_source"] for h in resp.get("hits", {}).get("hits", [])]


def _gateway(es: InMemoryESClient, store: UsageStore, budget: BudgetConfig) -> LLMGateway:
    gate = BudgetGate(get_budget=lambda: budget, usage_store=store)
    return LLMGateway(Secrets(_env_file=None), store, provider_overrides={"openai": OkProvider()},
                      budget_gate=gate)


CFG = ModelConfig(provider="openai", model="gpt-4o", max_tokens=100)
BLOCK_AT_ONE = BudgetConfig(enabled=True, daily_usd=1.0, on_exceed="block")


def test_the_exempt_surfaces_agree() -> None:
    assert BUDGET_EXEMPT_SURFACES == EXCLUDED_SURFACES == ("chat",)
    assert budget_exempt("chat", "chat") and not budget_exempt("chat", "report")
    assert not budget_exempt("investigator", "chat") and not budget_exempt("chat", "")


async def test_investigations_still_block_while_chat_proceeds() -> None:
    es = InMemoryESClient()
    store = await _ledger(es, ("investigate", "investigator", 5.0, 30))   # pipeline over $1
    gw = _gateway(es, store, BLOCK_AT_ONE)
    with pytest.raises(BudgetBlocked):
        await gw.complete(Role.INVESTIGATOR, MESSAGES, CFG, surface="investigate")
    result = await gw.complete(Role.CHAT, MESSAGES, CFG, surface="chat")
    assert result.text.endswith("ok")
    docs = await _usage_docs(es)
    chat_rows = [d for d in docs if d["surface"] == "chat"]
    assert len(chat_rows) == 1 and chat_rows[0]["cost"] > 0          # still metered (#6)


async def test_chat_spend_does_not_consume_the_pipeline_budget() -> None:
    es = InMemoryESClient()
    store = await _ledger(es, ("chat", "chat", 9.0, 90), ("investigate", "investigator", 0.2, 30))
    gw = _gateway(es, store, BLOCK_AT_ONE)
    # $9.20 spent today, but only $0.20 of it is the pipeline's: an investigation runs.
    result = await gw.complete(Role.INVESTIGATOR, MESSAGES, CFG, surface="investigate")
    assert result.text
    status = await BudgetGate(get_budget=lambda: BLOCK_AT_ONE, usage_store=store).status()
    # $0.20 plus the investigation call just made; never the $9 of chat.
    assert status["daily"]["spent"] == pytest.approx(0.2, abs=0.01) and status["daily"]["band"] == "ok"
    assert status["excluded_surfaces"] == ["chat"] and status["excluded_today"] == pytest.approx(9.0)
    # The monthly window excludes chat exactly.
    month = await BudgetGate(get_budget=lambda: BudgetConfig(enabled=True, monthly_usd=1.0, daily_usd=None,
                                                             on_exceed="block"),
                             usage_store=store).check(prompt_chars=10, max_tokens=10, model="gpt-4o",
                                                      exclude_surfaces=("chat",))
    assert month["action"] == "allow"


async def test_a_gate_without_the_exclusion_keyword_still_works() -> None:
    class LegacyGate:
        calls: list[dict[str, Any]] = []

        async def check(self, *, prompt_chars: int = 0, max_tokens: int = 0, model: str = "",
                        overlay: Any = None) -> dict[str, Any]:
            self.calls.append({"prompt_chars": prompt_chars})
            return {"action": "allow"}

    gate = LegacyGate()
    es = InMemoryESClient()
    gw = LLMGateway(Secrets(_env_file=None), UsageStore(es), provider_overrides={"openai": OkProvider()},
                    budget_gate=gate)
    await gw.complete(Role.INVESTIGATOR, MESSAGES, CFG, surface="investigate")
    await gw.complete(Role.CHAT, MESSAGES, CFG, surface="chat")         # exempt: not consulted
    assert len(gate.calls) == 1
    assert "exclude_surfaces" not in inspect.signature(LegacyGate.check).parameters
    assert gateway_module._accepts_keyword(BudgetGate(lambda: None, None).check, "exclude_surfaces")


async def test_surface_spend_today_reads_the_chat_rows() -> None:
    es = InMemoryESClient()
    store = await _ledger(es, ("chat", "chat", 2.5, 60), ("chat", "chat", 0.5, 5),
                          ("investigate", "investigator", 4.0, 10))
    gate = BudgetGate(get_budget=lambda: BLOCK_AT_ONE, usage_store=store)
    assert await gate.surface_spend_today("chat") == pytest.approx(3.0)


# --------------------------------------------------------------------------- #
# The chat daily cap, enforced by the engine (off by default).
# --------------------------------------------------------------------------- #
class CapGate:
    def __init__(self, spent: float) -> None:
        self.spent = spent
        self.reads = 0

    async def surface_spend_today(self, surface: str) -> float:
        self.reads += 1
        assert surface == "chat"
        return self.spent

    def estimate_cost(self, prompt: Any, max_tokens: int, model: str = "", overlay: Any = None) -> float:
        return 0.01


def _prefs(**cfg: Any) -> Preferences:
    agent = ChatAgentConfig(**cfg)
    return Preferences().model_copy(update={"chat_agent": agent})


async def _turn(gateway: Any, prefs: Preferences, gate: Any) -> tuple[Any, TurnOutcome]:
    outcome = TurnOutcome()
    events = [e async for e in make_engine(gateway).run_turn(
        "q", prefs, tool_context=make_ctx(prefs, budget_gate=gate), outcome=outcome)]
    return events[-1].response, outcome


async def test_the_chat_cap_is_off_by_default() -> None:
    assert ChatAgentConfig().chat_daily_cap_usd is None
    gateway = FakeGateway([final("Answered.")])
    resp, _ = await _turn(gateway, _prefs(), CapGate(spent=10_000.0))
    assert resp.answer == "Answered." and resp.notice is None


async def test_the_chat_cap_gives_the_budget_notice() -> None:
    gateway = FakeGateway([final("never")])
    gate = CapGate(spent=5.0)                                         # at the cap: the next call would cross it
    resp, outcome = await _turn(gateway, _prefs(chat_daily_cap_usd=5.0), gate)
    assert gateway.calls == []                                        # refused before the provider
    assert resp.notice.kind == "budget" and resp.notice.message == NOTICE_MESSAGES["chat_budget"]
    assert outcome.first_call_failed and not outcome.persist and gate.reads == 1
    under = FakeGateway([final("Answered.")])
    resp2, _ = await _turn(under, _prefs(chat_daily_cap_usd=5.0), CapGate(spent=1.0))
    assert resp2.answer == "Answered." and resp2.notice is None


async def test_demo_mode_never_meets_the_chat_cap() -> None:
    gateway = FakeGateway([final("Demo answer.")])
    prefs = _prefs(chat_daily_cap_usd=0.01)
    outcome = TurnOutcome()
    events = [e async for e in make_engine(gateway).run_turn(
        "q", prefs, tool_context=make_ctx(prefs, budget_gate=CapGate(spent=99.0), demo_active=True),
        outcome=outcome)]
    assert events[-1].response.answer == "Demo answer."


async def test_a_chat_turn_over_the_pipeline_budget_answers_and_is_ledgered() -> None:
    """End to end on the real gateway: the pipeline budget is exhausted, chat still
    answers (no budget notice) and its call is one UsageDoc on the chat surface."""
    es = InMemoryESClient()
    store = await _ledger(es, ("investigate", "investigator", 50.0, 30))
    gw = _gateway(es, store, BLOCK_AT_ONE)
    prefs = Preferences().model_copy(update={"chat_model": ModelConfig(provider="openai", model="gpt-4o")})
    outcome = TurnOutcome()
    engine = make_engine(gw, es=es)
    events = [e async for e in engine.run_turn("q", prefs, tool_context=make_ctx(prefs), outcome=outcome)]
    resp = events[-1].response
    assert resp.answer == "ok" and resp.notice is None
    chat_rows = [d for d in await _usage_docs(es) if d["surface"] == "chat"]
    assert len(chat_rows) == 1


# --------------------------------------------------------------------------- #
# Review fixes: an exact midnight-aligned chat share (D5), the cap in bounded mode,
# the cap re-read per call and across concurrent turns, replay runs.
# --------------------------------------------------------------------------- #
def _at(monkeypatch: pytest.MonkeyPatch, when) -> None:
    """Freeze the ledger's and the gate's clocks at ``when`` (UTC)."""
    monkeypatch.setattr("app.stores.usage.now_utc", lambda: when)
    monkeypatch.setattr("app.stores.sql.repositories.now_utc", lambda: when)
    monkeypatch.setattr(budget_module, "now_utc", lambda: when)


async def _rows(store: Any, *rows: tuple[str, str, float, Any]) -> Any:
    """Write ``(surface, role, cost, ts)`` rows."""
    for surface, role, cost, ts in rows:
        await store.write(UsageDoc(ts=ts.isoformat(), surface=surface, role=role, model="gpt-4o", cost=cost,
                                   prompt_tokens=10, completion_tokens=10, total_tokens=20))
    return store


def _day(hour: int, minute: int):
    return NOON.replace(hour=hour, minute=minute)


@pytest.mark.parametrize("now", [_day(0, 40), _day(0, 59), _day(5, 59), _day(5, 50), _day(23, 59)])
async def test_chat_spent_after_midnight_never_counts_against_investigations(
    monkeypatch: pytest.MonkeyPatch, now,
) -> None:
    """The excluded chat share is exactly today's (since 00:00 UTC), not a rolling
    window of whole hours: chat at 00:20 is excluded at 00:40 and at XX:59."""
    _at(monkeypatch, now)
    store = await _rows(UsageStore(InMemoryESClient()),
                        ("chat", "chat", 9.5, _day(0, 20)),
                        ("investigate", "investigator", 0.2, _day(0, 30)))
    gate = BudgetGate(get_budget=lambda: BudgetConfig(enabled=True, daily_usd=10.0, on_exceed="block"),
                      usage_store=store)
    decision = await gate.check(prompt_chars=40, max_tokens=100, model="gpt-4o", exclude_surfaces=("chat",))
    assert decision["action"] == "allow"
    status = await gate.status()
    assert status["daily"]["spent"] == pytest.approx(0.2) and status["excluded_today"] == pytest.approx(9.5)
    gw = _gateway(InMemoryESClient(), store, BLOCK_AT_ONE)
    assert (await gw.complete(Role.INVESTIGATOR, MESSAGES, CFG, surface="investigate")).text


async def test_the_chat_cap_never_counts_yesterdays_chat(monkeypatch: pytest.MonkeyPatch) -> None:
    _at(monkeypatch, _day(0, 10))
    store = await _rows(UsageStore(InMemoryESClient()),
                        ("chat", "chat", 4.0, _day(0, 10) - timedelta(minutes=40)),   # 23:30 yesterday
                        ("chat", "chat", 1.0, _day(0, 5)))
    gate = BudgetGate(get_budget=lambda: BLOCK_AT_ONE, usage_store=store)
    assert await gate.surface_spend_today("chat") == pytest.approx(1.0)


async def test_the_sql_ledger_reports_todays_spend_per_surface(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.stores.sql import SqlUsageRepository, build_async_engine, create_all

    engine = build_async_engine("sqlite+aiosqlite:///:memory:")
    await create_all(engine)
    try:
        _at(monkeypatch, _day(0, 40))
        store = await _rows(SqlUsageRepository(engine),
                            ("chat", "chat", 4.0, _day(0, 40) - timedelta(hours=2)),   # yesterday
                            ("chat", "chat", 9.5, _day(0, 20)),
                            ("investigate", "investigator", 0.2, _day(0, 30)))
        summary = await store.summary(window_hours=24)
        today = {row["key"]: row["cost"] for row in summary["today_by_surface"]}
        assert today == {"chat": pytest.approx(9.5), "investigate": pytest.approx(0.2)}
        gate = BudgetGate(get_budget=lambda: BudgetConfig(enabled=True, daily_usd=1.0, on_exceed="block"),
                          usage_store=store)
        assert (await gate.check(prompt_chars=40, max_tokens=10, model="gpt-4o",
                                 exclude_surfaces=("chat",)))["action"] == "allow"
        assert await gate.surface_spend_today("chat") == pytest.approx(9.5)
    finally:
        await engine.dispose()


async def test_a_ledger_without_todays_surface_split_keeps_the_conservative_fallback() -> None:
    """An out-of-tree repository without ``today_by_surface``: the excluded share is
    read over whole hours rounded down (never over-excluded)."""
    class Legacy:
        def __init__(self) -> None:
            self.windows: list[int] = []

        async def summary(self, window_hours: int = 24, case_id: Any = None) -> dict[str, Any]:
            self.windows.append(window_hours)
            return {"today_cost": 5.0, "total_cost": 5.0,
                    "by_surface": [{"key": "chat", "cost": 4.0}, {"key": "investigate", "cost": 1.0}]}

    legacy = Legacy()
    gate = BudgetGate(get_budget=lambda: BLOCK_AT_ONE, usage_store=legacy)
    spent = await gate._window_spend(("chat",))
    assert spent["excluded_daily"] == pytest.approx(4.0) and legacy.windows[-1] == 12   # NOON: 12 whole hours


async def test_the_chat_cap_applies_in_bounded_mode() -> None:
    gateway = FakeGateway([final("never")])
    gate = CapGate(spent=500.0)
    resp, outcome = await _turn(gateway, _prefs(limits_mode="bounded", chat_daily_cap_usd=5.0), gate)
    assert gateway.calls == [] and gate.reads == 1
    assert resp.notice.kind == "budget" and resp.notice.message == NOTICE_MESSAGES["chat_budget"]
    assert outcome.first_call_failed and not outcome.persist
    under = FakeGateway([final("Answered.")])
    resp2, _ = await _turn(under, _prefs(limits_mode="bounded", chat_daily_cap_usd=5.0), CapGate(spent=1.0))
    assert resp2.answer == "Answered." and resp2.notice is None


class RisingGate(CapGate):
    """Today's chat spend as other turns bill while this one runs."""

    def __init__(self, readings: list[float], estimate: float = 0.01) -> None:
        super().__init__(spent=readings[0])
        self.readings = list(readings)
        self.estimate = estimate

    async def surface_spend_today(self, surface: str) -> float:
        self.reads += 1
        return self.readings.pop(0) if len(self.readings) > 1 else self.readings[0]

    def estimate_cost(self, prompt: Any, max_tokens: int, model: str = "", overlay: Any = None) -> float:
        return self.estimate


@pytest.mark.parametrize("mode", ["unlimited", "bounded"])
async def test_the_chat_cap_is_reread_before_every_model_call(mode: str) -> None:
    from tests.test_chat_engine_loop import tool_call

    gateway = FakeGateway([tool_call("log_stats", group_by="a"), final("never")])
    gate = RisingGate([1.0, 18.0])                     # other turns billed $17 meanwhile
    resp, outcome = await _turn(gateway, _prefs(limits_mode=mode, chat_daily_cap_usd=5.0), gate)
    assert len(gateway.calls) == 1 and gate.reads == 2
    assert resp.notice.kind == "budget" and resp.notice.message == NOTICE_MESSAGES["chat_budget"]
    assert outcome.persist                             # the first step billed: the work so far is kept


async def test_concurrent_turns_count_each_others_calls_in_flight() -> None:
    """Turn A's call is in flight (not yet in the ledger); turn B's first call would
    cross the cap with it, so B is refused. Nothing stays reserved afterwards."""
    import asyncio

    from app.agents import chat as chat_module

    gate = RisingGate([0.0], estimate=3.0)             # cap $5: one $3 call fits, two do not
    slow = FakeGateway([final("A answered.")], delay=0.3)
    fast = FakeGateway([final("never")])
    prefs = _prefs(chat_daily_cap_usd=5.0)

    async def turn_b():
        await asyncio.sleep(0.1)
        return await _turn(fast, prefs, gate)

    (resp_a, _), (resp_b, _) = await asyncio.gather(_turn(slow, prefs, gate), turn_b())
    assert resp_a.answer == "A answered." and resp_a.notice is None
    assert fast.calls == [] and resp_b.notice.kind == "budget"
    assert chat_module._in_flight_for(gate).total() == 0.0
    # Once A's call has ended, a new turn fits again (its cost is in the ledger now).
    resp_c, _ = await _turn(FakeGateway([final("C answered.")]), prefs, gate)
    assert resp_c.answer == "C answered."


async def test_chat_spend_never_trips_a_replay_run() -> None:
    from app.engine.replay.stack import ReplayBudgetGate, ReplaySpendLimiter

    store = await _ledger(InMemoryESClient(), ("chat", "chat", 10.5, 30))
    tenant = BudgetGate(get_budget=lambda: BudgetConfig(enabled=True, daily_usd=10.0, on_exceed="block"),
                        usage_store=store)
    limiter = ReplaySpendLimiter(5.0, UsageStore(InMemoryESClient()))
    replay_gate = ReplayBudgetGate(tenant, limiter)
    assert gateway_module._accepts_keyword(replay_gate.check, "exclude_surfaces")
    es = InMemoryESClient()
    gw = LLMGateway(Secrets(_env_file=None), UsageStore(es), provider_overrides={"openai": OkProvider()},
                    budget_gate=replay_gate)
    assert (await gw.complete(Role.INVESTIGATOR, MESSAGES, CFG, surface="investigate")).text
    assert not limiter.tripped
    # Without the exclusion (an old caller) the deployment ceiling still counts it all.
    blocked = await replay_gate.check(prompt_chars=10, max_tokens=10, model="gpt-4o")
    assert blocked["action"] == "block" and limiter.tripped_reason == "tenant_budget"


async def test_a_cancelled_turn_releases_its_call_in_flight(monkeypatch: pytest.MonkeyPatch) -> None:
    import asyncio

    from app.agents import chat as chat_module

    gate = RisingGate([0.0], estimate=3.0)
    prefs = _prefs(chat_daily_cap_usd=5.0)
    task = asyncio.ensure_future(_turn(FakeGateway([final("never")], delay=5), prefs, gate))
    await asyncio.sleep(0.05)
    assert chat_module._in_flight_for(gate).total() == pytest.approx(3.0)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert chat_module._in_flight_for(gate).total() == 0.0
    # A reservation that was never released is forgotten after the TTL.
    tracker = chat_module._ChatSpendInFlight()
    tracker.reserve(3.0)
    monkeypatch.setattr(chat_module, "_IN_FLIGHT_TTL_S", -1)
    assert tracker.total() == 0.0


async def test_the_elasticsearch_summary_splits_todays_spend_by_surface() -> None:
    """Real Elasticsearch computes the sums: ``today_by_surface`` is a terms split inside
    the same ``today_cost`` filter (the rows since 00:00 UTC), never a rolling window."""
    class AggES:
        def __init__(self) -> None:
            self.bodies: list[dict[str, Any]] = []

        async def search(self, index: str, body: dict[str, Any]) -> dict[str, Any]:
            self.bodies.append(body)
            bucket = lambda key, cost: {"key": key, "doc_count": 2, "cost": {"value": cost},  # noqa: E731
                                        "tokens": {"value": 40}}
            return {"hits": {"total": {"value": 5}}, "aggregations": {
                "total_cost": {"value": 13.7}, "total_tokens": {"value": 100},
                "today_cost": {"doc_count": 3, "cost": {"value": 9.7},
                               "by_surface": {"buckets": [bucket("chat", 9.5), bucket("investigate", 0.2)]}},
                "by_surface": {"buckets": [bucket("chat", 13.5), bucket("investigate", 0.2)]},
            }}

    es = AggES()
    summary = await UsageStore(es).summary(window_hours=24)
    today_agg = es.bodies[0]["aggs"]["today_cost"]
    assert today_agg["aggs"]["by_surface"]["terms"]["field"] == "surface"
    assert {r["key"]: r["cost"] for r in summary["today_by_surface"]} == {"chat": 9.5, "investigate": 0.2}
    gate = BudgetGate(get_budget=lambda: BudgetConfig(enabled=True, daily_usd=1.0, on_exceed="block"),
                      usage_store=UsageStore(AggES()))
    spent = await gate._window_spend(("chat",))
    assert spent["daily"] == pytest.approx(0.2) and spent["excluded_daily"] == pytest.approx(9.5)
