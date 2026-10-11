"""Round 12 query-robustness golden set (SPEC §4 WP-DEMO, SYNTHESIS-chat P0-11).

At least 120 realistic SOC analyst questions — every question from the operator's
screenshots verbatim, app help, IOC lookups, case questions, logs, metrics, cost,
comparisons, reports and genuinely ambiguous asks — each run END TO END through
``POST /api/chat/stream`` in Demo Mode (the real engine, the real tools over the
seeded demo stores and sources, the deterministic $0 planner playing the model).

Every answer must be a real answer where the data exists: no ``unsupported`` notice
(only the two questions about data no lookup reads may carry it), no empty answer, the
expected lookups ran and succeeded with VALID inputs (a planner input the tool rejects
would surface as "Invalid input"), ``answer_kind`` is "product_help" only for questions
about the console, report requests come back with ``saved_report`` (the server saved
the report, SPEC D11), and ambiguous asks come back with ``clarify`` (SPEC D10).

A second part scripts the model (a pushed script on the demo provider wins over the
planner) with the tool inputs a real model sends for the screenshot questions, and
checks that they validate and return EXACT figures: totals equal a direct count of the
case store, no "lower bound", no window capped to 30 days (SPEC D7/D8).
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Iterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.routes import router as base_router
from app.api.routes_chat import router as chat_router
from app.api.routes_chat_library import router as library_router
from app.api.routes_reports import router as reports_router
from app.config import Secrets
from app.es.fake import InMemoryESClient
from app.llm import providers
from app.llm.providers import MockProvider
from app.state import AppState

#: Demo history deep enough for month breakdowns and month-over-month comparisons.
HISTORY_DAYS = 60
ACTIVE_STATUSES = frozenset({"new", "open", "needs_human", "investigating", "escalated", "on_hold"})


# --------------------------------------------------------------------------- #
# The golden questions.
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class G:
    """One golden question and what its answer must show."""

    q: str
    kind: str | tuple[str, ...] = "data"     # expected answer_kind ("any" = not checked)
    tools: tuple[str, ...] = ()              # each must have run and succeeded
    any_of: tuple[str, ...] = ()             # at least one must have run and succeeded
    report: bool = False                     # the server saved a report (saved_report)
    sections: int = 0                        # the saved report's envelope has at least this many sections
    clarify: bool = False                    # a clarify card, no lookups
    unsupported: bool = False                # the "unsupported" notice is allowed (data no lookup reads)
    min_lookups: int = 0
    may_fail: tuple[str, ...] = ()           # tools allowed a non-ok status (a missing case, a refused lookup)
    notices: tuple[str, ...] = ()            # extra allowed notice kinds


SCREENSHOT = [
    # Verbatim from the operator's screenshots (Round 12 asks 3 and 5).
    G("Create a report of lifetime performance pls thanks", tools=("case_stats", "soc_metrics"), report=True,
      sections=6, min_lookups=6),
    G("Last 90 days or whatever reports you can", tools=("case_stats", "soc_metrics"), report=True, sections=6,
      min_lookups=6),
    G("The amount of total cases right now that are open, when were they all opened ? Segregate month wise pls "
      "thanks", tools=("case_stats",)),
    # The follow-up chips shown under those answers.
    G("Show the available active-case records", tools=("search_cases",)),
    G("Break down newly created cases by month instead", tools=("case_stats",)),
    G("Show the detailed 30-day case mix", tools=("soc_metrics",)),
    G("Compare this report with the previous 30 days", tools=("case_stats", "soc_metrics"), report=True),
    G("Show the cases contributing to the acknowledgement delay", tools=("search_cases", "soc_metrics")),
]

REPORTS = [
    G("Monthly SOC report for September 2026", tools=("case_stats", "soc_metrics"), report=True, sections=6),
    G("Create an executive summary for this quarter", tools=("case_stats", "soc_metrics"), report=True, sections=6),
    G("Make an infographic of our posture this quarter", tools=("case_stats", "soc_metrics"), report=True,
      sections=6),
    G("Give me an investigation brief for case demo-00000539-0052", tools=("get_case", "explain_decision"),
      report=True, sections=5),
    G("Generate a weekly report", tools=("case_stats", "soc_metrics"), report=True, sections=6),
    G("Produce a quarterly report for last quarter", tools=("case_stats", "soc_metrics"), report=True),
    G("Generate a SOC performance report for the last 6 months", tools=("case_stats", "soc_metrics"),
      report=True, sections=6),
    G("Make me a report on this month", tools=("case_stats", "soc_metrics"), report=True, sections=6),
    G("Build a posture report", tools=("soc_metrics",), report=True),
    G("Give me a shift handover report", tools=("shift_report", "soc_metrics"), report=True),
    G("Create an IOC report on 203.0.113.42", tools=("lookup_indicator", "search_logs", "search_cases"),
      report=True),
    G("Build a hunt report on lateral movement", tools=("search_cases", "get_case"), report=True,
      may_fail=("lookup_indicator",), notices=("denied", "policy")),
    G("Write an executive summary of our SOC for leadership", tools=("case_stats", "soc_metrics"), report=True),
    G("Can you put together a monthly report for August 2026?", tools=("case_stats", "soc_metrics"), report=True),
]

CASE_COUNTS = [
    G("How many cases were created each month this year?", tools=("case_stats",)),
    G("How many cases are open right now, grouped by severity?", tools=("case_stats",)),
    G("Which analysts closed the most cases last week?", tools=("case_stats",)),
    G("Show cases opened per month for the last 90 days", tools=("case_stats",)),
    G("Show all-time case stats", tools=("case_stats",)),
    G("Cases by status", tools=("case_stats",)),
    G("Break down cases by verdict for the last 30 days", tools=("case_stats",)),
    G("How many cases per week this quarter?", tools=("case_stats",)),
    G("Open cases by assignee", tools=("case_stats",)),
    G("Cases by rule this month", tools=("case_stats",)),
    G("How many critical cases did we get in the last 7 days?", tools=("case_stats",)),
    G("How many cases did we have in September?", tools=("case_stats",)),
    G("Cases by source for all time", tools=("case_stats",)),
    G("Weekly case volume for the last 12 weeks", tools=("case_stats",)),
    G("How many unassigned open cases are there by severity?", tools=("case_stats",)),
    G("Count of true positives by month", tools=("case_stats",)),
    G("How many false positives have we had in total?", tools=("case_stats",)),
    G("Daily case count for the last 2 weeks", tools=("case_stats",)),
    G("Cases by ATT&CK tactic", tools=("case_stats",)),
    G("How many cases did we close this month?", tools=("case_stats",)),
    G("Cases since March", any_of=("search_cases", "case_stats")),
]

TRENDS = [
    G("Show me the MTTR trend over the last 30 days", tools=("case_stats", "soc_metrics")),
    G("MTTA trend by week this quarter", tools=("case_stats", "soc_metrics")),
    G("False positive rate trend by month", tools=("case_stats",)),
    G("How is our FP rate trending?", tools=("case_stats",)),
    G("Case volume trend for the last 6 months", tools=("soc_metrics", "case_stats")),
    G("Alert trend this week", tools=("soc_metrics", "log_stats")),
    G("Show the risk trend over the last 90 days", tools=("case_stats",)),
    G("How has MTTD changed over time?", tools=("case_stats", "soc_metrics")),
    G("AI cost trend by day this month", tools=("cost_usage",)),
    G("Trend of cases by severity over the last 30 days", tools=("soc_metrics", "case_stats")),
]

COMPARISONS = [
    G("Compare this month vs last month: cases, FP rate, MTTR", tools=("case_stats", "soc_metrics")),
    G("How does this quarter compare with last quarter?", tools=("case_stats", "soc_metrics")),
    G("Compare this week with last week", tools=("case_stats", "soc_metrics")),
    G("This month vs the same month last year", tools=("case_stats", "soc_metrics")),
    G("Is our FP rate better or worse than last month?", tools=("case_stats", "soc_metrics")),
    G("Compare Q3 2026 vs Q2 2026", tools=("case_stats", "soc_metrics")),
    G("Month over month case volume", tools=("case_stats", "soc_metrics")),
    G("Compare AI spend this month with last month", tools=("cost_usage",)),
    G("How many alerts did we get this week compared to last week?", tools=("log_stats",)),
    G("Year over year cases", tools=("case_stats", "soc_metrics")),
]

METRICS = [
    G("How is our security posture right now?", tools=("soc_metrics",)),
    G("What is our false positive rate over all time?", tools=("soc_metrics",)),
    G("What's our automation rate this month?", tools=("soc_metrics",)),
    G("Show the noise reduction funnel for the last 7 days", tools=("soc_metrics",)),
    G("What is our MTTR?", tools=("soc_metrics",)),
    G("How are we doing this week?", tools=("soc_metrics",)),
    G("What's the active risk index?", kind=("mixed", "data"), tools=("soc_metrics",)),
    G("Show our ATT&CK coverage", tools=("soc_metrics",)),
    G("Show me the auto-close health", tools=("soc_metrics",)),
    G("What is our SLA attainment this month?", tools=("soc_metrics",)),
]

COST = [
    G("What did the AI spend this month?", tools=("cost_usage",)),
    G("How much did we spend on AI by month?", tools=("cost_usage",)),
    G("AI spend by model for the last 30 days", tools=("cost_usage",)),
    G("How many tokens did we use today?", tools=("cost_usage",)),
    G("What did AI cost yesterday?", tools=("cost_usage",)),
    G("Show AI spend by role this year", tools=("cost_usage",)),
]

LOGS = [
    G("Top rules in the last 90 days", tools=("log_stats",)),
    G("Which hosts generated the most alerts this week?", tools=("log_stats",)),
    G("Show failed logins by source IP in the last 24 hours", tools=("log_stats", "search_cases")),
    G("Search logs for mimikatz", tools=("search_logs",)),
    G("Show me the logs for host dc01 in the last 7 days", tools=("search_logs",)),
    G("How many events mention powershell?", tools=("log_stats",)),
    G("Top users by events today", tools=("log_stats",)),
    G("Which source IPs are noisiest?", tools=("log_stats",)),
    G("Any brute force on our VPN?", tools=("log_stats", "search_cases")),
    G("Search logs for user pnair", tools=("search_logs",)),
    G("Events by severity this week", tools=("log_stats",)),
    G("Show me the logs for today", tools=("search_logs",)),
]

INTEL = [
    G("Look up 203.0.113.42", tools=("lookup_indicator", "search_logs", "search_cases")),
    G("Is 192.0.2.118 malicious?", tools=("lookup_indicator", "search_logs", "search_cases")),
    G("Check the reputation of 203.0.113.86", tools=("lookup_indicator",)),
    G("Hunt the source IP behind the newest SQL injection case", tools=("search_cases", "get_case"),
      may_fail=("lookup_indicator",), notices=("denied", "policy")),
    G("What do we know about 198.51.100.7?", tools=("lookup_indicator", "search_logs")),
    G("Explain ATT&CK technique T1110", tools=("mitre_lookup",)),
]

CASES = [
    G("Explain case demo-00000539-0004", tools=("get_case", "explain_decision")),
    G("Why was case demo-00000539-0024 closed?", tools=("get_case", "explain_decision")),
    # A case that does not exist: a clear data answer, never "chat cannot read that data".
    G("Explain case case-0001", min_lookups=2, may_fail=("get_case", "explain_decision")),
    G("Investigate the newest escalated case", tools=("search_cases", "get_case", "explain_decision")),
    G("List open critical cases", tools=("search_cases",)),
    G("Show me the newest escalated case", tools=("search_cases", "get_case")),
    G("Summarise today's true positives", tools=("search_cases", "soc_metrics")),
    G("What happened today?", tools=("search_cases",)),
    G("Show me cases from last week", tools=("search_cases",)),
    G("List unassigned open cases", tools=("search_cases",)),
]

DEEP = [
    # Long multi-step investigations: the unlimited loop runs 10+ lookups over 3-4 rounds.
    G("Investigate everything about host dc01 over the last 30 days",
      tools=("log_stats", "search_logs", "search_cases", "case_stats"), min_lookups=10,
      may_fail=("lookup_indicator",), notices=("denied", "policy")),
    G("Deep dive into user pnair this month", tools=("log_stats", "search_logs", "get_case", "explain_decision"),
      min_lookups=12, may_fail=("lookup_indicator",), notices=("denied", "policy")),
    G("Investigate everything about 203.0.113.42", tools=("lookup_indicator", "log_stats", "get_case"),
      min_lookups=12),
    G("Investigate everything about host jumpbox01", tools=("log_stats", "search_logs"), min_lookups=10,
      may_fail=("lookup_indicator",), notices=("denied", "policy")),
]

APP_HELP = [
    G("How do I configure SSO?", kind="product_help", tools=("app_help",)),
    G("How do I connect a new log source?", kind="product_help", tools=("app_help",)),
    G("What does the noise reduction funnel measure?", kind=("mixed", "product_help"), tools=("app_help",)),
    G("What can I do from this chat with my access?", kind="product_help", tools=("app_help", "app_status")),
    G("Where do I change the auto-close policy?", kind="product_help", tools=("app_help",)),
    G("What is MTTA?", kind=("mixed", "product_help"), tools=("app_help",)),
    G("How do I add a model?", kind="product_help", tools=("app_help",)),
    G("What version is this?", kind="product_help", tools=("app_help", "app_status")),
    G("How do reports work?", kind="product_help", tools=("app_help",)),
    G("How do I export a report as PDF?", kind="product_help", tools=("app_help",)),
]

PLATFORM = [
    G("Are any log sources silent?", tools=("source_health",)),
    G("Which campaigns are open?", tools=("list_campaigns",)),
    G("Show pending approvals", tools=("automation_status",)),
    G("What did agents do in the last 24 hours?", tools=("audit_search",)),
    G("Show the threshold tuning status", tools=("automation_status",)),
    G("Which runbooks cover brute force?", tools=("search_knowledge",)),
]

CLARIFY = [
    G("show me the trend", kind="conversation", clarify=True),
    G("What's the trend?", kind="conversation", clarify=True),
    G("compare", kind="conversation", clarify=True),
    G("how many?", kind="conversation", clarify=True),
    G("break it down", kind="conversation", clarify=True),
]

READ_ONLY = [
    # Chat is read-only: a change request is answered from the Help Center.
    G("Close case demo-00000539-0004", kind="product_help", tools=("app_help",)),
    G("Delete all closed cases", kind="product_help", tools=("app_help",)),
    # The only questions about data no lookup reads: "unsupported" is honest here.
    G("List the console users", kind="product_help", tools=("app_help",), unsupported=True),
    G("Which notification channels are configured?", kind="product_help", tools=("app_help",), unsupported=True),
]

GOLDEN: list[G] = [*SCREENSHOT, *REPORTS, *CASE_COUNTS, *TRENDS, *COMPARISONS, *METRICS, *COST, *LOGS, *INTEL,
                   *CASES, *DEEP, *APP_HELP, *PLATFORM, *CLARIFY, *READ_ONLY]


def test_the_golden_set_is_big_enough_and_has_every_screenshot_question() -> None:
    questions = [g.q for g in GOLDEN]
    assert len(questions) >= 120 and len(set(questions)) == len(questions)
    for verbatim in ("Create a report of lifetime performance pls thanks",
                     "Last 90 days or whatever reports you can",
                     ("The amount of total cases right now that are open, when were they all opened ? Segregate "
                      "month wise pls thanks")):
        assert verbatim in questions


# --------------------------------------------------------------------------- #
# The Demo Mode app (auth off: the shared default profile).
# --------------------------------------------------------------------------- #
@pytest.fixture(scope="module")
def client() -> Iterator[TestClient]:
    patch = pytest.MonkeyPatch()
    patch.setattr(providers, "DEMO_STREAM_DELAY_S", 0)
    secrets = Secrets(_env_file=None, es_store_enabled=False, redis_url="",
                      anthropic_api_key=None, openai_api_key=None)
    overrides = {"anthropic": MockProvider(), "openai": MockProvider(), "mock": MockProvider()}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        state = AppState.create(secrets=secrets, es=InMemoryESClient(), provider_overrides=overrides)
        await state.startup(start_poller=False)
        await state.update_prefs(state.prefs.model_copy(update={"setup_complete": True}))
        await state.enable_demo(mode="seeded", seed=1337, history_days=HISTORY_DAYS)
        app.state.tlsoc = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    for router in (base_router, chat_router, library_router, reports_router):
        api.include_router(router)
    try:
        with TestClient(api) as test_client:
            yield test_client
    finally:
        patch.undo()


def _key(*parts: str) -> str:
    return "golden-" + hashlib.sha256("|".join(parts).encode()).hexdigest()[:24]


def _stream(client: TestClient, question: str, **fields: Any) -> dict[str, Any]:
    """One turn through ``POST /api/chat/stream``: the final ``turn.done`` response."""
    payload: dict[str, Any] = {"message": question, "origin": "user", **fields}
    response = client.post("/api/chat/stream", json=payload)
    assert response.status_code == 200, (question, response.status_code, response.text[:400])
    events = [json.loads(line) for line in response.text.splitlines() if line.strip()]
    errors = [e for e in events if e.get("type") == "turn.error"]
    assert not errors, (question, errors)
    done = [e for e in events if e.get("type") == "turn.done"]
    assert done, (question, [e.get("type") for e in events])
    return done[-1]["response"]


def _tool_steps(response: dict[str, Any]) -> list[dict[str, Any]]:
    return [s for s in response.get("steps") or [] if s.get("kind") == "tool"]


_REFERENCE = ("app_help", "app_status")


def _check(g: G, response: dict[str, Any]) -> None:
    answer = response.get("answer") or ""
    steps = _tool_steps(response)
    ok = {s["tool"] for s in steps if s.get("status") == "ok"}
    data_steps = [s for s in steps if s["tool"] not in _REFERENCE]
    context = (g.q, answer[:600], [(s["tool"], s.get("status"), s.get("summary")) for s in steps])
    # A real answer, never the planner's safe final or the unmapped-question fallback.
    assert answer.strip(), context
    assert "could not plan an answer" not in answer and "I could not map that" not in answer, context
    # SPEC D9: "unsupported" only for data no lookup reads; never "limited" from Demo.
    notice = (response.get("notice") or {}).get("kind")
    allowed = {None, *g.notices} | ({"unsupported", "unsupported_no_link"} if g.unsupported else set())
    assert notice in allowed, (notice, context)
    # Every lookup the planner sent validated and ran (no "Invalid input", no failure
    # outside the expected ones such as a missing case or a refused indicator).
    for step in steps:
        assert "Invalid input" not in (step.get("summary") or ""), context
        if step["tool"] not in g.may_fail:
            assert step.get("status") == "ok", (step["tool"], step.get("status"), context)
    for tool in g.tools:
        assert tool in ok, (tool, context)
    if g.any_of:
        assert ok & set(g.any_of), context
    assert len(steps) >= g.min_lookups, (len(steps), context)
    # "Product help" is shown only for answers about the console (SPEC D9).
    kind = response.get("answer_kind")
    if kind == "product_help":
        assert not data_steps, context
    if g.kind != "any":
        expected = g.kind if isinstance(g.kind, tuple) else (g.kind,)
        assert kind in expected, (kind, context)
    if kind in ("data", "mixed"):
        assert data_steps, context
        assert response.get("blocks") or re.search(r"\d", answer), context
    # Exact aggregates: no figure presented as a sample bound, no window capped to 30 days.
    for step in data_steps:
        summary = (step.get("summary") or "").lower()
        assert "capped" not in summary and "720" not in summary, context
    # SPEC D10: ambiguous asks clarify instead of guessing.
    clarify = response.get("clarify")
    if g.clarify:
        assert clarify and 2 <= len(clarify["options"]) <= 4 and not steps, context
        assert all(len(o) <= 80 for o in clarify["options"]) and len(clarify["question"]) <= 200
    else:
        assert clarify is None, context
    # SPEC D11: report requests are saved to Reports by the server.
    saved = response.get("saved_report")
    if g.report:
        assert saved and saved.get("id") and saved.get("items", 0) >= 1, (saved, response.get("saved_report_error"),
                                                                           context)
        envelope = next((b for b in response.get("blocks") or [] if b.get("type") == "report"), None)
        assert envelope is not None, context
        assert len(envelope.get("sections") or []) >= g.sections, ([s.get("heading") for s in
                                                                   envelope.get("sections") or []], context)
    else:
        assert saved is None, context


@pytest.mark.parametrize("g", GOLDEN, ids=[re.sub(r"[^a-z0-9]+", "-", g.q.lower())[:60] for g in GOLDEN])
def test_golden_question_answers_end_to_end(client: TestClient, g: G) -> None:
    fields: dict[str, Any] = {}
    if g.report:
        # A report is saved from the PERSISTED answer (SPEC D11): a Workspace conversation.
        fields = {"persist_conversation": True, "idempotency_key": _key("report", g.q)}
    _check(g, _stream(client, g.q, **fields))


def test_golden_answers_are_deterministic(client: TestClient) -> None:
    """The same question gives the same answer, blocks and lookups (byte-identical)."""
    for question in (("The amount of total cases right now that are open, when were they all opened ? Segregate "
                      "month wise pls thanks"), "Compare this month vs last month: cases, FP rate, MTTR",
                     "Show me the MTTR trend over the last 30 days"):
        first, second = _stream(client, question), _stream(client, question)
        assert first["answer"] == second["answer"]
        assert [(s["tool"], s.get("params"), s.get("summary")) for s in _tool_steps(first)] == [
            (s["tool"], s.get("params"), s.get("summary")) for s in _tool_steps(second)]
        # Block generation stamps (``generated_at``, ``as_of``) are the turn's clock.
        strip = re.compile(r'"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+\+00:00"')
        assert strip.sub("", json.dumps(first["blocks"], sort_keys=True)) == strip.sub(
            "", json.dumps(second["blocks"], sort_keys=True))


# --------------------------------------------------------------------------- #
# Conversations: a clarify pick, a zero-result suggestion, /compact, a view change.
# --------------------------------------------------------------------------- #
def test_a_clarify_pick_answers_the_trend_it_names(client: TestClient) -> None:
    first = _stream(client, "show me the trend", persist_conversation=True,
                    idempotency_key=_key("clarify", "1"))
    assert first["clarify"]["options"] == ["Alerts", "Cases", "AI cost", "FP rate"]
    second = _stream(client, "Cases", origin="clarify", persist_conversation=True,
                     conversation_id=first["conversation_id"], idempotency_key=_key("clarify", "2"))
    tools = {s["tool"] for s in _tool_steps(second) if s.get("status") == "ok"}
    assert {"soc_metrics", "case_stats"} <= tools and second["clarify"] is None
    assert second["answer_kind"] == "data" and second["blocks"]


def test_a_zero_result_offers_suggestions_that_run(client: TestClient) -> None:
    first = _stream(client, "How many cases were created each month in 2024?", persist_conversation=True,
                    idempotency_key=_key("zero", "1"))
    assert first["answer"].startswith("No case matched in 2024.") and "all time" in first["answer"]
    assert "Show the same for all time" in first["follow_ups"]
    second = _stream(client, "Show the same for all time", origin="follow_up", persist_conversation=True,
                     conversation_id=first["conversation_id"], idempotency_key=_key("zero", "2"))
    (step,) = _tool_steps(second)
    assert step["tool"] == "case_stats" and step["status"] == "ok" and "all time" in step["summary"]
    assert not second["answer"].startswith("No case matched")


def test_compact_summarises_the_conversation_in_demo(client: TestClient) -> None:
    first = _stream(client, "How is our security posture right now?", persist_conversation=True,
                    idempotency_key=_key("compact", "1"))
    cid = first["conversation_id"]
    _stream(client, "Which campaigns are open?", persist_conversation=True, conversation_id=cid,
            idempotency_key=_key("compact", "2"))
    compact = _stream(client, "/compact", persist_conversation=True, conversation_id=cid,
                      idempotency_key=_key("compact", "3"))
    assert compact["compacted"] is True and compact["answer"].startswith("Summarised 2 earlier exchanges")
    after = _stream(client, "What did the AI spend this month?", persist_conversation=True, conversation_id=cid,
                    idempotency_key=_key("compact", "4"))
    assert {s["tool"] for s in _tool_steps(after)} == {"cost_usage"}


def test_a_view_change_reuses_the_stored_numbers(client: TestClient) -> None:
    first = _stream(client, "The amount of total cases right now that are open, when were they all opened ? "
                            "Segregate month wise pls thanks", persist_conversation=True,
                    idempotency_key=_key("reshape", "1"))
    assert "Show the open cases by month as a table" in first["follow_ups"]
    second = _stream(client, "Show the open cases by month as a table", origin="follow_up",
                     persist_conversation=True, conversation_id=first["conversation_id"],
                     idempotency_key=_key("reshape", "2"))
    assert not _tool_steps(second)
    assert [b.get("kind") or b.get("type") for b in second["blocks"]] == ["table"]


# --------------------------------------------------------------------------- #
# A scripted model: the inputs a real model sends for the screenshot questions.
# --------------------------------------------------------------------------- #
def _state(client: TestClient) -> AppState:
    return client.app.state.tlsoc  # type: ignore[attr-defined]


def _push(client: TestClient, *replies: Any) -> None:
    provider = _state(client)._demo._provider  # the demo stack's own provider
    for reply in replies:
        provider.push("chat", reply if isinstance(reply, str) else json.dumps(reply))


def _final(header: dict[str, Any], body: str) -> str:
    return json.dumps({"action": "final", "citations": [], "console_links": [], "follow_ups": [],
                       "answer_kind": "data", "memory_proposal": None, **header}) + "\n---ANSWER---\n" + body


def _ground_truth(client: TestClient) -> dict[str, Any]:
    """A direct count of the demo case store: every case, and the open ones by the
    UTC month they were opened."""
    async def count() -> dict[str, Any]:
        store = _state(client).cases
        total, active, by_month = 0, 0, {}
        cursor: Any = None
        seen: set[str] = set()
        for _page in range(1_000):
            rows, cursor, _snapshot, _consistency = await store.export_page(limit=500, cursor=cursor)
            rows = [case for case in rows if case.case_id not in seen]
            seen.update(case.case_id for case in rows)
            for case in rows:
                total += 1
                status = getattr(case.status, "value", case.status)
                if str(status) in ACTIVE_STATUSES:
                    active += 1
                    created = str(getattr(case, "created_at", "") or "")[:7]
                    by_month[created] = by_month.get(created, 0) + 1
            if cursor is None or not rows:
                break
        return {"total": total, "active": active, "active_by_month": by_month}

    return client.portal.call(count)  # type: ignore[union-attr]


def _observation(client: TestClient, response: dict[str, Any], index: int) -> dict[str, Any]:
    """What the model saw for one step (the step inspector, SPEC §3.2)."""
    url = (f"/api/chat/conversations/{response['conversation_id']}/messages/{response['message_id']}"
           f"/steps/{index}")
    reply = client.get(url)
    assert reply.status_code == 200, reply.text
    return reply.json()["observation"]


def _step_index(response: dict[str, Any], tool: str, nth: int = 1) -> int:
    seen = 0
    for step in response["steps"]:
        if step.get("kind") == "tool" and step["tool"] == tool:
            seen += 1
            if seen == nth:
                return step["index"]
    raise AssertionError(f"no step {nth} of {tool}")


def test_a_scripted_lifetime_report_counts_every_case_exactly(client: TestClient) -> None:
    truth = _ground_truth(client)
    _push(client,
          {"action": "tools", "calls": [
              {"tool": "case_stats", "input": {"window": "all", "bucket": "month",
                                               "metrics": ["count", "fp_rate", "mttr_p50"]}},
              {"tool": "soc_metrics", "input": {"kind": "posture", "window": "all"}},
              {"tool": "soc_metrics", "input": {"kind": "timing", "window": "all"}},
              {"tool": "soc_metrics", "input": {"kind": "noise_funnel", "window": "all"}}]},
          _final({"blocks": [{"type": "report", "title": "Lifetime performance", "template": "executive",
                              "sections": [{"heading": "Volume", "items": [{"ref": "t1.a2"}]},
                                           {"heading": "Posture", "items": [{"ref": "t2.a1"}]},
                                           {"heading": "Noise", "items": [{"ref": "t4.a1"}]}]}],
                  "report": {"title": "Lifetime performance", "template": "executive"}},
                 "The lifetime report is below."))
    response = _stream(client, "Create a report of lifetime performance pls thanks", persist_conversation=True,
                       idempotency_key=_key("scripted", "lifetime"))
    steps = _tool_steps(response)
    assert [s["status"] for s in steps] == ["ok"] * 4
    for step in steps:
        summary = step["summary"].lower()
        assert "lower bound" not in summary and "capped" not in summary and "30 days" not in summary
    assert steps[0]["summary"].startswith(f"{truth['total']:,} case") and "exact" in steps[0]["summary"]
    assert "all time" in steps[0]["summary"]
    observation = _observation(client, response, _step_index(response, "case_stats"))
    assert observation["total"] == truth["total"] and observation["exact"] is True
    assert sum(g["metrics"]["count"] for g in observation["groups"]) == truth["total"]
    assert response["saved_report"] and response["saved_report"]["title"] == "Lifetime performance"


@pytest.mark.parametrize("window_input", [{"window": "now-90d"}, {"window_hours": 2160}])
def test_a_scripted_90_day_window_is_never_cut_to_30_days(client: TestClient, window_input: dict[str, Any]) -> None:
    _push(client,
          {"action": "tools", "calls": [
              {"tool": "soc_metrics", "input": {"kind": "posture", **window_input}},
              {"tool": "case_stats", "input": {"bucket": "month", **window_input}},
              {"tool": "cost_usage", "input": dict(window_input)}]},
          _final({"blocks": [{"ref": "t1.a1"}]}, "The last 90 days are below."))
    response = _stream(client, "Last 90 days or whatever reports you can")
    steps = _tool_steps(response)
    assert [s["status"] for s in steps] == ["ok"] * 3
    for step in steps:
        assert "Invalid input" not in step["summary"] and "capped" not in step["summary"].lower()
        assert "last 90 days" in step["summary"], step["summary"]
        assert "30 days" not in step["summary"] and "720" not in step["summary"]


@pytest.mark.parametrize("stats_input", [
    {"status_group": "active", "group_by": ["month"]},          # a grouping by creation month
    {"status_group": "active", "bucket": "month"},
    {"status_group": "active", "group_by": "created_month"},
])
def test_scripted_open_cases_by_month_match_the_store(client: TestClient, stats_input: dict[str, Any]) -> None:
    truth = _ground_truth(client)
    _push(client,
          {"action": "tool", "tool": "case_stats", "input": stats_input},
          _final({"blocks": [{"ref": "t1.a2", "view": "bar"}]}, "Open cases by the month they were opened."))
    response = _stream(client, "The amount of total cases right now that are open, when were they all opened ? "
                               "Segregate month wise pls thanks", persist_conversation=True,
                       idempotency_key=_key("scripted", "open-month", json.dumps(stats_input, sort_keys=True)))
    (step,) = _tool_steps(response)
    assert step["status"] == "ok" and "by month" in step["summary"], step["summary"]
    assert step["summary"].startswith(f"{truth['active']:,} case") and "exact" in step["summary"]
    observation = _observation(client, response, step["index"])
    assert observation["total"] == truth["active"] and observation["exact"] is True
    counts = {g["bucket"]: g["metrics"]["count"] for g in observation["groups"]}
    assert sum(counts.values()) == truth["active"]
    # Each month bucket equals the store's own count for that (UTC) month.
    months: dict[str, int] = {}
    for label, n in counts.items():
        name, year = label.split(" (")[0].split()[:2]
        months[f"{year}-{_MONTHS.index(name) + 1:02d}"] = n
    expected = {month: n for month, n in truth["active_by_month"].items() if n}
    assert {k: v for k, v in months.items() if v} == expected
    assert "lower bound" not in json.dumps(observation).lower()


_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
