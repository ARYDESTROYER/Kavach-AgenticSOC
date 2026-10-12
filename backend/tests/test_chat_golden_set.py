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
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
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
class Fig:
    """A figure the answer must state, counted DIRECTLY from the case store.

    ``text`` holds ``{n}`` (the count with thousands separators); when the store
    count is zero, ``zero`` must appear instead. ``window`` is a window spec
    (``None`` = every case, ``"step:<tool>"`` = the window of the ``params``-matched
    step of that tool) and ``filters`` the case filters (``status_group``,
    ``status``, ``severity``, ``verdict``)."""

    text: str
    window: Any = None
    filters: dict[str, str] = field(default_factory=dict)
    zero: str = "No "


def P(tool: str, **subset: Any) -> tuple[str, dict[str, Any]]:
    """An expected parameter subset for one lookup: an ``ok`` step of ``tool`` must
    carry each key with this value (``"re:<pattern>"`` matches by regex, ``None``
    means the key is absent: no window, no filter)."""
    return tool, subset


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
    max_lookups: int | None = None           # e.g. a product question runs no data lookup
    may_fail: tuple[str, ...] = ()           # tools allowed a non-ok status (a missing case, a refused lookup)
    notices: tuple[str, ...] = ()            # extra allowed notice kinds
    # What the lookups actually asked for (the routing.md DEGRADE class: a window
    # silently changed, a filter or grouping dropped, a different question answered).
    params: tuple[tuple[str, dict[str, Any]], ...] = ()
    forbid: tuple[tuple[str, dict[str, Any]], ...] = ()   # no ok step of the tool may match
    figures: tuple[Fig, ...] = ()            # figures checked against a direct store count
    contains: tuple[str, ...] = ()           # answer text ("re:" = a multiline regex)
    absent: tuple[str, ...] = ()             # text the answer must not contain
    title: str | None = None                 # regex the saved report title must match
    fields: dict[str, Any] = field(default_factory=dict)  # extra request fields (a scope chip)


#: Date-relative expectations, computed when the module loads (the demo history is
#: seeded relative to now, so these hold on any day the suite runs).
_NOW = datetime.now(UTC)
_THIS_MONTH_TITLE = rf"^{_NOW:%B %Y} SOC report$"
_THIS_QUARTER = rf"Q{(_NOW.month - 1) // 3 + 1} {_NOW.year}"
_ACTIVE = {"status_group": "active"}
_TERMINAL = {"status_group": "terminal"}
_CANT_CHANGE = "I can't change that from chat"
#: A direction answer; in the first hours of a month the baseline (the previous month
#: to the same elapsed time) may hold no closed case, and the answer then says there
#: is no direction to report rather than guessing one.
_DIRECTION = r"re:^(?:\*\*(?:Better|Worse|No change)\*\*: |There is no direction to report: )"
#: A month that lies wholly inside a "last 90 days" scope chip on any day the suite
#: runs (the month 45 days ago: it starts at most 76 days ago and ended at least 14
#: days ago), and the month that straddles the chip's start (the one 90 days ago).
_INSIDE_CHIP = _NOW - timedelta(days=45)
_STRADDLES_CHIP = _NOW - timedelta(days=90)
_CHIP_90D = {"time_range": {"from": "now-90d", "to": "now"}}
#: A count compared with the period before: the compared rows, or (both periods
#: empty, as at the very start of a week) the one sentence that says so.
_COMPARED = r"re:Compared with the previous period:|, and none in .+ either\."

SCREENSHOT = [
    # Verbatim from the operator's screenshots (Round 12 asks 3 and 5).
    G("Create a report of lifetime performance pls thanks", tools=("case_stats", "soc_metrics"), report=True,
      sections=6, min_lookups=6, title=r"^Lifetime performance report$",
      params=(P("case_stats", window="all", bucket="month"), P("soc_metrics", kind="posture", window="all")),
      figures=(Fig("**{n} cases**", "all"),)),
    G("Last 90 days or whatever reports you can", tools=("case_stats", "soc_metrics"), report=True, sections=6,
      min_lookups=6, title=r"last 90 days",
      params=(P("case_stats", window="now-90d", bucket="month"), P("soc_metrics", kind="posture", window="now-90d"))),
    G("The amount of total cases right now that are open, when were they all opened ? Segregate month wise pls "
      "thanks", tools=("case_stats",), params=(P("case_stats", status_group="active", bucket="month"),),
      figures=(Fig("**{n} cases are open right now**", None, _ACTIVE),)),
    # The follow-up chips shown under those answers.
    G("Show the available active-case records", tools=("search_cases",),
      params=(P("search_cases", status_group="active"),), figures=(Fig("**{n} open cases**", None, _ACTIVE),)),
    G("Break down newly created cases by month instead", tools=("case_stats",),
      params=(P("case_stats", bucket="month", status_group=None),), figures=(Fig("**{n} cases**", "all"),)),
    G("Show the detailed 30-day case mix", tools=("soc_metrics",),
      params=(P("soc_metrics", kind="case_mix", window="now-30d"),)),
    G("Compare this report with the previous 30 days", tools=("case_stats", "soc_metrics"), report=True,
      params=(P("case_stats", window="now-30d", compare="previous_period"),)),
    G("Show the cases contributing to the acknowledgement delay", tools=("search_cases", "soc_metrics"),
      params=(P("search_cases", status_group="active", sort_field="created_at"),),
      contains=("Oldest first: these have waited longest",)),
]

REPORTS = [
    G("Monthly SOC report for September 2026", tools=("case_stats", "soc_metrics"), report=True, sections=6,
      title=r"^September 2026 SOC report$", params=(P("case_stats", window="2026-09"),)),
    G("Create an executive summary for this quarter", tools=("case_stats", "soc_metrics"), report=True, sections=6,
      title=rf"^Executive summary, {_THIS_QUARTER}$", params=(P("case_stats", window="this_quarter"),),
      figures=(Fig("**{n} cases**", "this_quarter"),)),
    G("Make an infographic of our posture this quarter", tools=("case_stats", "soc_metrics"), report=True,
      sections=6, title=rf"^Posture infographic, {_THIS_QUARTER}$",
      params=(P("soc_metrics", kind="posture", window="this_quarter"),)),
    G("Give me an investigation brief for case demo-00000539-0052", tools=("get_case", "explain_decision"),
      report=True, sections=5, title=r"^Investigation brief: demo-00000539-0052$",
      params=(P("get_case", case_id="demo-00000539-0052"),)),
    G("Generate a weekly report", tools=("case_stats", "soc_metrics"), report=True, sections=6,
      title=r"last 7 days$", params=(P("case_stats", window="now-7d"),)),
    G("Produce a quarterly report for last quarter", tools=("case_stats", "soc_metrics"), report=True,
      title=r"^SOC performance report, Q\d \d{4}$", params=(P("case_stats", window="last_quarter"),)),
    G("Generate a SOC performance report for the last 6 months", tools=("case_stats", "soc_metrics"),
      report=True, sections=6, title=r"last 6 months$", params=(P("case_stats", window="now-6M"),)),
    G("Make me a report on this month", tools=("case_stats", "soc_metrics"), report=True, sections=6,
      title=rf"^SOC performance report, {_NOW:%B %Y}$", params=(P("case_stats", window="this_month"),),
      figures=(Fig("**{n} cases**", "this_month"),)),
    G("Build a posture report", tools=("soc_metrics",), report=True, title=r"^Posture report, last 24 hours$",
      params=(P("soc_metrics", kind="posture"),)),
    G("Build a posture report for last month", tools=("soc_metrics",), report=True,
      title=r"^Posture report, [A-Z][a-z]+ \d{4}$", params=(P("soc_metrics", kind="posture", window="last_month"),)),
    G("Give me a shift handover report", tools=("shift_report", "soc_metrics"), report=True, title=r"^Shift brief"),
    G("Create an IOC report on 203.0.113.42", tools=("lookup_indicator", "search_logs", "search_cases"),
      report=True, title=r"^IOC report: 203\.0\.113\.42$",
      params=(P("lookup_indicator", indicator="203.0.113.42", kind="ip"),)),
    G("Create an IOC report on 192.0.2.118", tools=("lookup_indicator", "search_logs", "search_cases"),
      report=True, title=r"^IOC report: 192\.0\.2\.118$"),
    G("Build a hunt report on lateral movement", tools=("search_cases", "get_case"), report=True,
      may_fail=("lookup_indicator",), notices=("denied", "policy"), title=r"^Hunt report: demo-"),
    G("Build a hunt report on phishing", tools=("search_cases",), report=True,
      may_fail=("lookup_indicator",), notices=("denied", "policy"), title=r"^Hunt report: phishing$"),
    G("Create an investigation report for case demo-00000539-0004", tools=("get_case", "explain_decision"),
      report=True, title=r"^Investigation report: demo-00000539-0004$"),
    G("Write an executive summary of our SOC for leadership", tools=("case_stats", "soc_metrics"), report=True,
      title=r"^Executive summary", params=(P("case_stats", window="now-30d"),)),
    G("Can you put together a monthly report for August 2026?", tools=("case_stats", "soc_metrics"), report=True,
      title=r"^August 2026 SOC report$", params=(P("case_stats", window="2026-08"),)),
]

CASE_COUNTS = [
    G("How many cases were created each month this year?", tools=("case_stats",),
      params=(P("case_stats", bucket="month", window="this_year"),), figures=(Fig("**{n} cases**", "this_year"),)),
    G("How many cases are open right now, grouped by severity?", tools=("case_stats",),
      params=(P("case_stats", group_by="severity", status_group="active"),),
      figures=(Fig("**{n} cases are open right now**", None, _ACTIVE),)),
    G("Which analysts closed the most cases last week?", tools=("case_stats",),
      params=(P("case_stats", group_by="assignee", status_group="terminal", window="last_week"),),
      contains=("it does not record which analyst closed each one",),
      figures=(Fig("**{n} closed cases**", "last_week", _TERMINAL),)),
    G("Show cases opened per month for the last 90 days", tools=("case_stats",),
      params=(P("case_stats", bucket="month", window="now-90d"),)),
    G("Show all-time case stats", tools=("case_stats",), params=(P("case_stats", window="all"),),
      figures=(Fig("**{n} cases**", "all"),)),
    G("Cases by status", tools=("case_stats",), params=(P("case_stats", group_by="status"),)),
    G("Break down cases by verdict for the last 30 days", tools=("case_stats",),
      params=(P("case_stats", group_by="verdict", window="now-30d"),)),
    G("How many cases per week this quarter?", tools=("case_stats",),
      params=(P("case_stats", bucket="week", window="this_quarter"),), figures=(Fig("**{n} cases**", "this_quarter"),)),
    G("Open cases by assignee", tools=("case_stats",),
      params=(P("case_stats", group_by="assignee", status_group="active"),)),
    G("Cases by rule this month", tools=("case_stats",),
      params=(P("case_stats", group_by="rule", window="this_month"),),
      figures=(Fig("**{n} cases**", "this_month"),)),
    G("How many critical cases did we get in the last 7 days?", tools=("case_stats",),
      params=(P("case_stats", severity="critical", window="now-7d"),)),
    G("How many cases did we have in September?", tools=("case_stats",),
      params=(P("case_stats", window=r"re:^\d{4}-09$"),), figures=(Fig("**{n} cases**", "step:case_stats"),),
      absent=("last 12 months",)),
    G("Cases by source for all time", tools=("case_stats",),
      params=(P("case_stats", group_by="source", window="all"),)),
    G("Weekly case volume for the last 12 weeks", tools=("case_stats",),
      params=(P("case_stats", bucket="week", window="now-12w"),)),
    G("How many unassigned open cases are there by severity?", tools=("case_stats",),
      params=(P("case_stats", group_by="severity", status_group="active", assignee="unassigned"),)),
    G("Count of true positives by month", tools=("case_stats",),
      params=(P("case_stats", bucket="month", verdict="TRUE_POSITIVE"),),
      figures=(Fig("**{n} true positive cases**", "all", {"verdict": "TRUE_POSITIVE"}),)),
    G("How many false positives have we had in total?", tools=("case_stats",),
      params=(P("case_stats", window="all", verdict="FALSE_POSITIVE"),),
      figures=(Fig("**{n} false positive cases**", "all", {"verdict": "FALSE_POSITIVE"}),)),
    G("Daily case count for the last 2 weeks", tools=("case_stats",),
      params=(P("case_stats", bucket="day", window="now-2w"),)),
    G("Cases by ATT&CK tactic", tools=("case_stats",), params=(P("case_stats", group_by="mitre_tactic"),)),
    G("How many cases did we close this month?", tools=("case_stats",),
      params=(P("case_stats", status_group="terminal", window="this_month"),),
      figures=(Fig("**{n} closed cases**", "this_month", _TERMINAL),)),
    G("Cases since March", any_of=("search_cases", "case_stats"),
      params=(P("search_cases", window=r"re:^\d{4}-03-01$"),)),
]

TRENDS = [
    G("Show me the MTTR trend over the last 30 days", tools=("case_stats", "soc_metrics"),
      params=(P("case_stats", bucket="day", window="now-30d", metrics="re:mttr_p50"),
              P("soc_metrics", kind="timing", window="now-30d"))),
    G("MTTA trend by week this quarter", tools=("case_stats", "soc_metrics"),
      params=(P("case_stats", bucket="week", window="this_quarter", metrics="re:mtta_p50"),)),
    G("False positive rate trend by month", tools=("case_stats",),
      params=(P("case_stats", bucket="month", metrics="re:fp_rate"),)),
    G("How is our FP rate trending?", tools=("case_stats",),
      params=(P("case_stats", bucket="re:.", metrics="re:fp_rate"),)),
    G("Case volume trend for the last 6 months", tools=("soc_metrics", "case_stats"),
      params=(P("soc_metrics", kind="trends", window="now-6M"), P("case_stats", window="now-6M", bucket="week"))),
    G("Alert trend this week", tools=("soc_metrics", "log_stats"),
      params=(P("log_stats", window="this_week"), P("soc_metrics", kind="trends", window="this_week"))),
    G("Show the risk trend over the last 90 days", tools=("case_stats",),
      params=(P("case_stats", window="now-90d", metrics="re:mean_risk"),)),
    G("How has MTTD changed over time?", tools=("case_stats", "soc_metrics"),
      params=(P("case_stats", bucket="re:.", metrics="re:mttd_p50"),)),
    G("AI cost trend by day this month", tools=("cost_usage",),
      params=(P("cost_usage", window="this_month", bucket="day"),)),
    G("Trend of cases by severity over the last 30 days", tools=("soc_metrics", "case_stats"),
      params=(P("case_stats", group_by="severity", bucket="day", window="now-30d"),)),
]

COMPARISONS = [
    G("Compare this month vs last month: cases, FP rate, MTTR", tools=("case_stats", "soc_metrics"),
      params=(P("case_stats", window="this_month", compare="previous_period"),)),
    G("How does this quarter compare with last quarter?", tools=("case_stats", "soc_metrics"),
      params=(P("case_stats", window="this_quarter", compare="previous_period"),)),
    G("Compare this week with last week", tools=("case_stats", "soc_metrics"),
      params=(P("case_stats", window="this_week", compare="previous_period"),)),
    G("This month vs the same month last year", tools=("case_stats", "soc_metrics"),
      params=(P("case_stats", window="this_month", compare="same_period_last_year"),)),
    G("Is our FP rate better or worse than last month?", tools=("case_stats", "soc_metrics"),
      params=(P("case_stats", window="this_month", compare="previous_period"),), contains=(_DIRECTION,)),
    G("Compare Q3 2026 vs Q2 2026", tools=("case_stats", "soc_metrics"),
      params=(P("soc_metrics", kind="posture", window="2026-Q3", compare="2026-Q2"),)),
    G("Month over month case volume", tools=("case_stats", "soc_metrics"),
      params=(P("case_stats", window="this_month", compare="previous_period"),)),
    G("Compare AI spend this month with last month", tools=("cost_usage",),
      params=(P("cost_usage", window="this_month", compare="previous_period"),)),
    G("How many alerts did we get this week compared to last week?", tools=("log_stats",),
      params=(P("log_stats", window="this_week", compare="previous_period"),)),
    G("Year over year cases", tools=("case_stats", "soc_metrics"),
      params=(P("case_stats", window="this_year", compare="same_period_last_year"),)),
]

METRICS = [
    G("How is our security posture right now?", tools=("soc_metrics",), params=(P("soc_metrics", kind="posture"),)),
    G("What is our false positive rate over all time?", tools=("soc_metrics",),
      params=(P("soc_metrics", kind="posture", window="all"),), contains=(r"re:\AFalse-positive rate \*\*",)),
    # The named figure leads, measured or not (a quiet start of a month has none to give).
    G("What's our automation rate this month?", tools=("soc_metrics",),
      params=(P("soc_metrics", kind="posture", window="this_month"),),
      contains=(r"re:\AAutomation rate(?: \*\*|: not measured)",)),
    G("Show the noise reduction funnel for the last 7 days", tools=("soc_metrics",),
      params=(P("soc_metrics", kind="noise_funnel", window="now-7d"),)),
    G("What is our MTTR?", tools=("soc_metrics",), params=(P("soc_metrics", kind="timing"),)),
    G("How are we doing this week?", tools=("soc_metrics",),
      params=(P("soc_metrics", kind="posture", window="this_week"),)),
    G("What's the active risk index?", kind=("mixed", "data"), tools=("soc_metrics",)),
    G("Show our ATT&CK coverage", tools=("soc_metrics",), params=(P("soc_metrics", kind="mitre_coverage"),)),
    G("Show me the auto-close health", tools=("soc_metrics",), params=(P("soc_metrics", kind="auto_close_health"),)),
    G("What is our SLA attainment this month?", tools=("soc_metrics",),
      params=(P("soc_metrics", kind="posture", window="this_month"),), contains=(r"re:\ASLA attainment[ :]",)),
]

COST = [
    G("What did the AI spend this month?", tools=("cost_usage",), params=(P("cost_usage", window="this_month"),)),
    G("How much did we spend on AI by month?", tools=("cost_usage",), params=(P("cost_usage", bucket="month"),)),
    G("AI spend by model for the last 30 days", tools=("cost_usage",),
      params=(P("cost_usage", window="now-30d", group_by="model"),)),
    G("How many tokens did we use today?", tools=("cost_usage",), params=(P("cost_usage", window="today"),)),
    G("What did AI cost yesterday?", tools=("cost_usage",), params=(P("cost_usage", window="yesterday"),)),
    G("Show AI spend by role this year", tools=("cost_usage",),
      params=(P("cost_usage", window="this_year", group_by="role"),)),
]

LOGS = [
    G("Top rules in the last 90 days", tools=("log_stats",),
      params=(P("log_stats", group_by="rule", time_from="now-90d"),)),
    G("Which hosts generated the most alerts this week?", tools=("log_stats",),
      params=(P("log_stats", group_by="host", window="this_week"),)),
    G("Show failed logins by source IP in the last 24 hours", tools=("log_stats", "search_cases"),
      params=(P("log_stats", group_by="ip", contains="fail", time_from="now-24h"),),
      contains=(r"re:\ALog events matching the text filter",)),
    G("Search logs for mimikatz", tools=("search_logs",), params=(P("search_logs", contains="mimikatz"),)),
    G("Show me the logs for host dc01 in the last 7 days", tools=("search_logs",),
      params=(P("search_logs", host="dc01", time_from="now-7d", contains=None),)),
    G("How many events mention powershell?", tools=("log_stats",), params=(P("log_stats", contains="powershell"),)),
    G("Top users by events today", tools=("log_stats",), params=(P("log_stats", group_by="user", window="today"),)),
    G("Which source IPs are noisiest?", tools=("log_stats",), params=(P("log_stats", group_by="ip"),)),
    G("Any brute force on our VPN?", tools=("log_stats", "search_cases"), params=(P("log_stats", contains="fail"),)),
    G("Search logs for user pnair", tools=("search_logs",), params=(P("search_logs", user="pnair", contains=None),)),
    G("Events by severity this week", tools=("log_stats",),
      params=(P("log_stats", group_by="severity", window="this_week"),)),
    G("Show me the logs for today", tools=("search_logs",), params=(P("search_logs", window="today", contains=None),)),
]

INTEL = [
    G("Look up 203.0.113.42", tools=("lookup_indicator", "search_logs", "search_cases"),
      params=(P("lookup_indicator", indicator="203.0.113.42", kind="ip"), P("search_cases", entity="203.0.113.42"))),
    G("Is 192.0.2.118 malicious?", tools=("lookup_indicator", "search_logs", "search_cases"),
      params=(P("lookup_indicator", indicator="192.0.2.118"),)),
    G("Check the reputation of 203.0.113.86", tools=("lookup_indicator",),
      params=(P("lookup_indicator", indicator="203.0.113.86"),)),
    G("Hunt the source IP behind the newest SQL injection case", tools=("search_cases", "get_case"),
      may_fail=("lookup_indicator",), notices=("denied", "policy")),
    G("What do we know about 198.51.100.7?", tools=("lookup_indicator", "search_logs"),
      params=(P("search_logs", ip="198.51.100.7"),)),
    G("Explain ATT&CK technique T1110", tools=("mitre_lookup",), params=(P("mitre_lookup", ids="T1110"),)),
]

CASES = [
    G("Explain case demo-00000539-0004", tools=("get_case", "explain_decision"),
      params=(P("get_case", case_id="demo-00000539-0004"),)),
    G("Why was case demo-00000539-0024 closed?", tools=("get_case", "explain_decision"),
      params=(P("explain_decision", case_id="demo-00000539-0024"),)),
    # A case that does not exist: a clear data answer, never "chat cannot read that data".
    G("Explain case case-0001", min_lookups=2, may_fail=("get_case", "explain_decision"),
      contains=("No case with the id `case-0001` was found",)),
    G("Investigate the newest escalated case", tools=("search_cases", "get_case", "explain_decision"),
      params=(P("search_cases", status="escalated", sort_field="created_at"),)),
    G("List open critical cases", tools=("search_cases",),
      params=(P("search_cases", status_group="active", severity="critical"),),
      figures=(Fig("**{n} open critical case", None, {**_ACTIVE, "severity": "critical"}),)),
    G("Show me the newest escalated case", tools=("search_cases", "get_case"),
      params=(P("search_cases", status="escalated"),)),
    G("Summarise today's true positives", tools=("search_cases", "soc_metrics"),
      params=(P("search_cases", verdict="TRUE_POSITIVE", window="today"),)),
    G("What happened today?", tools=("search_cases",), params=(P("search_cases", window="today"),)),
    G("Show me cases from last week", tools=("search_cases",), params=(P("search_cases", window="last_week"),),
      figures=(Fig("**{n} cases**", "last_week"),)),
    G("List unassigned open cases", tools=("search_cases",),
      params=(P("search_cases", status_group="active", assignee="unassigned"),)),
]

DEEP = [
    # Long multi-step investigations: the unlimited loop runs 10+ lookups over 3-4 rounds.
    G("Investigate everything about host dc01 over the last 30 days",
      tools=("log_stats", "search_logs", "search_cases", "case_stats"), min_lookups=10,
      may_fail=("lookup_indicator",), notices=("denied", "policy"),
      params=(P("search_logs", host="dc01", time_from="now-30d"), P("case_stats", entity="dc01", window="now-30d"))),
    G("Deep dive into user pnair this month", tools=("log_stats", "search_logs", "get_case", "explain_decision"),
      min_lookups=12, may_fail=("lookup_indicator",), notices=("denied", "policy"),
      params=(P("search_logs", user="pnair", window="this_month"),)),
    G("Investigate everything about 203.0.113.42", tools=("lookup_indicator", "log_stats", "get_case"),
      min_lookups=12, params=(P("lookup_indicator", indicator="203.0.113.42"), P("search_logs", ip="203.0.113.42"))),
    G("Investigate everything about host jumpbox01", tools=("log_stats", "search_logs"), min_lookups=10,
      may_fail=("lookup_indicator",), notices=("denied", "policy"), params=(P("search_logs", host="jumpbox01"),)),
]

APP_HELP = [
    G("How do I configure SSO?", kind="product_help", tools=("app_help",), max_lookups=1),
    G("How do I connect a new log source?", kind="product_help", tools=("app_help",), max_lookups=1),
    G("What does the noise reduction funnel measure?", kind=("mixed", "product_help"), tools=("app_help",)),
    G("What can I do from this chat with my access?", kind="product_help", tools=("app_help", "app_status")),
    G("Where do I change the auto-close policy?", kind="product_help", tools=("app_help",), max_lookups=1),
    G("What is MTTA?", kind=("mixed", "product_help"), tools=("app_help",)),
    G("How do I add a model?", kind="product_help", tools=("app_help",), max_lookups=1),
    G("What version is this?", kind="product_help", tools=("app_help", "app_status")),
    G("How do reports work?", kind="product_help", tools=("app_help",), max_lookups=1),
    G("How do I export a report as PDF?", kind="product_help", tools=("app_help",), max_lookups=1),
]

PLATFORM = [
    G("Are any log sources silent?", tools=("source_health",)),
    G("Which campaigns are open?", tools=("list_campaigns",), params=(P("list_campaigns", status="open"),)),
    G("Show pending approvals", tools=("automation_status",), params=(P("automation_status", kind="approvals"),)),
    G("What did agents do in the last 24 hours?", tools=("audit_search",),
      params=(P("audit_search", window="now-24h"),)),
    G("Show the threshold tuning status", tools=("automation_status",),
      params=(P("automation_status", kind="tuning"),)),
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
    G("Close case demo-00000539-0004", kind="product_help", tools=("app_help",), contains=(_CANT_CHANGE,)),
    G("Delete all closed cases", kind="product_help", tools=("app_help",), contains=(_CANT_CHANGE,)),
    # The only questions about data no lookup reads: "unsupported" is honest here.
    G("List the console users", kind="product_help", tools=("app_help",), unsupported=True),
    G("Which notification channels are configured?", kind="product_help", tools=("app_help",), unsupported=True),
]

#: Regressions from the WP-DEMO review (one or more per finding), each with the
#: parameters its lookups must carry and, where a count is the answer, the figure.
REGRESSIONS = [
    # A named month, quarter, "since", "all time" never ends up inside the search term.
    G("Show me the logs for host dc01 in October", tools=("search_logs",),
      params=(P("search_logs", host="dc01", window=r"re:^\d{4}-10$", contains=None),)),
    G("Search logs for mimikatz in September", tools=("search_logs",),
      params=(P("search_logs", contains="mimikatz", window=r"re:^\d{4}-09$"),)),
    G("Search logs for powershell since March", tools=("search_logs",),
      params=(P("search_logs", contains="powershell", window=r"re:^\d{4}-03-01$"),)),
    G("Show me the logs for host dc01 over all time", tools=("search_logs",),
      params=(P("search_logs", host="dc01", window="all", contains=None),)),
    G("Search logs for user pnair this quarter", tools=("search_logs",),
      params=(P("search_logs", user="pnair", window="this_quarter", contains=None),)),
    G("Search logs for mimikatz over all time", tools=("search_logs",),
      params=(P("search_logs", contains="mimikatz", window="all"),)),
    # A cadence word never overrides the period the analyst named.
    G("Monthly report for this month", tools=("case_stats", "soc_metrics"), report=True, title=_THIS_MONTH_TITLE,
      params=(P("case_stats", window="this_month"),)),
    G("Quarterly report for this quarter", tools=("case_stats", "soc_metrics"), report=True,
      title=rf", {_THIS_QUARTER}$", params=(P("case_stats", window="this_quarter"),)),
    G("Give me a weekly report for last week", tools=("case_stats", "soc_metrics"), report=True,
      title=r"^SOC performance report, W\d{1,2} \d{4}$", params=(P("case_stats", window="last_week"),)),
    G("Weekly summary for this week", tools=("case_stats", "soc_metrics"), report=True,
      params=(P("case_stats", window="this_week"),)),
    # Status and entity filters reach the lookup and the lead.
    G("How many cases were escalated this week?", tools=("case_stats",),
      params=(P("case_stats", status="escalated", window="this_week"),),
      figures=(Fig("**{n} escalated case", "this_week", {"status": "escalated"}),)),
    G("Show escalated cases by month", tools=("case_stats",),
      params=(P("case_stats", status="escalated", bucket="month"),),
      figures=(Fig("**{n} escalated case", None, {"status": "escalated"}),)),
    G("Show cases for user pnair", tools=("search_cases",), params=(P("search_cases", entity="pnair"),)),
    G("Cases involving host dc01", tools=("search_cases",), params=(P("search_cases", entity="dc01"),),
      contains=("No case involving `dc01` matched",)),
    G("How many cases did pnair have this month?", tools=("case_stats",),
      params=(P("case_stats", entity="pnair", window="this_month"),)),
    # Date phrasings: from a year, day ranges, older than, before, between.
    G("List critical cases from 2024", tools=("search_cases",),
      params=(P("search_cases", severity="critical", window="2024"),),
      figures=(Fig("**{n} critical case", "2024", {"severity": "critical"}, zero="No critical case matched in 2024"),)),
    G("cases from 1 Sep to 15 Sep", tools=("search_cases",),
      params=(P("search_cases", window=r"re:^\d{4}-09-01\.\.\d{4}-09-15$"),),
      figures=(Fig("**{n} cases**", "step:search_cases"),)),
    G("How many cases are older than 7 days and still open?", tools=("case_stats",),
      params=(P("case_stats", status_group="active", window='{"from":"all","to":"now-7d"}'),),
      figures=(Fig("**{n} open cases** were opened more than 7 days ago", {"from": "all", "to": "now-7d"}, _ACTIVE,
                   zero="No open case"),)),
    G("Cases opened before September", tools=("search_cases",),
      params=(P("search_cases", window=r"re:^all\.\.\d{4}-08$"),),
      figures=(Fig("**{n} cases**", "step:search_cases"),)),
    G("Cases between August 2026 and September 2026", tools=("search_cases",),
      params=(P("search_cases", window="2026-08..2026-09"),), forbid=(P("case_stats", compare="re:."),),
      figures=(Fig("**{n} cases**", "2026-08..2026-09"),)),
    # "What's the <metric> trend?" is a trend, not a definition.
    G("What's the FP rate trend?", tools=("case_stats",), max_lookups=1,
      params=(P("case_stats", bucket="re:^(?:day|week|month)$", metrics="re:fp_rate"),)),
    G("What's the MTTA trend for the last 6 months?", tools=("case_stats",),
      params=(P("case_stats", window="now-6M", bucket="re:.", metrics="re:mtta_p50"),), absent=("What the MTTA",)),
    G("What is the MTTR trend?", tools=("case_stats",), params=(P("case_stats", bucket="re:.", metrics="re:mttr_p50"),),
      absent=("What the MTTA",)),
    # Everyday comparison, improvement and breakdown phrasings.
    G("Compare last month with the month before", tools=("case_stats", "soc_metrics"),
      params=(P("case_stats", window="last_month", compare="previous_period"),)),
    G("Is MTTR improving?", tools=("case_stats", "soc_metrics"),
      params=(P("case_stats", window="this_month", compare="previous_period"),), contains=(_DIRECTION,)),
    G("Weekly breakdown of false positives this quarter", tools=("case_stats",),
      params=(P("case_stats", bucket="week", window="this_quarter", verdict="FALSE_POSITIVE"),),
      figures=(Fig("**{n} false positive case", "this_quarter", {"verdict": "FALSE_POSITIVE"}),)),
    G("Compare August 2026 and September 2026", tools=("case_stats", "soc_metrics"),
      params=(P("soc_metrics", kind="posture", window="2026-09", compare="2026-08"),),
      contains=("**Sep 2026 compared with Aug 2026**",)),
    # Alerts are log events, never cases.
    G("How many alerts did we get today?", tools=("log_stats",), params=(P("log_stats", window="today"),),
      forbid=(P("search_cases"), P("case_stats"))),
    G("How many alerts did we get yesterday?", tools=("log_stats",), params=(P("log_stats", window="yesterday"),),
      forbid=(P("search_cases"), P("case_stats"))),
    # Briefs without an id, and report titles that name the subject and period.
    G("Write me an investigation brief for the newest escalated case", tools=("search_cases", "get_case"),
      report=True, sections=5, title=r"^Investigation brief: demo-", params=(P("search_cases", status="escalated"),)),
    G("Create a PDF report of last month's cases", tools=("search_cases",), report=True,
      title=r"^Cases report, [A-Z][a-z]+ \d{4}$", params=(P("search_cases", window="last_month"),)),
    G("Make a report of open cases by severity", tools=("case_stats",), report=True, title=r"^Open cases report$",
      params=(P("case_stats", group_by="severity", status_group="active"),)),
    # A month or quarter without its year: dated by the anchor, never narrated as it.
    G("Show the MTTR trend for Q3", tools=("case_stats",),
      params=(P("case_stats", window=r"re:^\d{4}-Q3$", metrics="re:mttr_p50"),),
      absent=("last 12 months", "No period was named")),
    G("False positive rate trend in September", tools=("case_stats",),
      params=(P("case_stats", window=r"re:^\d{4}-09$", metrics="re:fp_rate"),), absent=("last 12 months",)),
    G("Investigate everything about user pnair in September", tools=("search_logs", "case_stats"), min_lookups=10,
      params=(P("search_logs", user="pnair", window=r"re:^\d{4}-09$"),), absent=("last 12 months",),
      may_fail=("lookup_indicator",), notices=("denied", "policy")),
    G("Q3 report", tools=("case_stats", "soc_metrics"), report=True, title=r"Q3 \d{4}$",
      params=(P("case_stats", window=r"re:^\d{4}-Q3$"),), absent=("No period was named",)),
    G("Create a report for September", tools=("case_stats", "soc_metrics"), report=True,
      title=r"^September \d{4} SOC report$", params=(P("case_stats", window=r"re:^\d{4}-09$"),),
      absent=("No period was named",)),
    G(f"How many cases were opened in {_INSIDE_CHIP:%B}?", tools=("case_stats",), fields=_CHIP_90D,
      params=(P("case_stats", window=rf"re:^{_INSIDE_CHIP:%Y-%m}$"),),
      contains=((rf"re:your question named {_INSIDE_CHIP:%B %Y}, so the lookups used that window "
                 r"instead of the last 90 days"),)),
    # A named month reaching outside the chip is limited to it, and the answer says so.
    G(f"How many cases were opened in {_STRADDLES_CHIP:%B %Y}?", tools=("case_stats",), fields=_CHIP_90D,
      params=(P("case_stats", window=f"{_STRADDLES_CHIP:%Y-%m}"),),
      contains=(r"re:Window: (?:1 lookup|\d+ lookups) asked for a window reaching outside the last 90 days you "
                r"selected, so (?:it was|they were) limited to the last 90 days",)),
    # Case age: "older than N days" is an upper bound, oldest first.
    G("Which open cases are older than 3 days?", tools=("search_cases",),
      params=(P("search_cases", status_group="active", window="all..now-3d", sort_field="created_at"),),
      figures=(Fig("**{n} open cases** were opened more than 3 days ago", {"from": "all", "to": "now-3d"}, _ACTIVE,
                   zero="No open case"),)),
    G("How many cases have been open for over 14 days?", tools=("case_stats",),
      params=(P("case_stats", status_group="active", window='{"from":"all","to":"now-14d"}'),),
      figures=(Fig("**{n} open cases** were opened more than 14 days ago", {"from": "all", "to": "now-14d"}, _ACTIVE,
                   zero="No open case"),)),
    # Open vs closed counts both groups.
    G("How many cases are open vs closed?", tools=("case_stats",),
      params=(P("case_stats", group_by="status_group", status_group=None),),
      figures=(Fig("Closed {n}", None, _TERMINAL), Fig("Open {n}", None, _ACTIVE))),
    G("How many open vs closed cases by severity?", tools=("case_stats",),
      params=(P("case_stats", group_by="status_group,severity", status_group=None),),
      figures=(Fig("Closed {n}", None, _TERMINAL), Fig("Open {n}", None, _ACTIVE))),
    # "Since last X": the current period against the named one.
    G("Has the case volume changed since last week?", tools=("case_stats",),
      params=(P("case_stats", window="this_week", compare="previous_period"),),
      contains=(r"re:^\*\*(?:Up|Down|No change)\*\*: the number of cases went from",)),
    G("How did our FP rate change since last month?", tools=("case_stats",),
      params=(P("case_stats", window="this_month", compare="previous_period"),), contains=(_DIRECTION,)),
    G("Have we improved since last month?", tools=("case_stats", "soc_metrics"),
      params=(P("case_stats", window="this_month", compare="previous_period"),)),
    # A write request that mentions an answer word stays a refused change.
    G("Create a review task for case demo-00000539-0004", kind="product_help", tools=("app_help",), max_lookups=1,
      contains=(_CANT_CHANGE,)),
    G("Create a dashboard with the alert trend", kind="product_help", tools=("app_help",), max_lookups=1,
      contains=(_CANT_CHANGE,)),
    G("Create a suppression list for 203.0.113.42", kind="product_help", tools=("app_help",), max_lookups=1,
      contains=(_CANT_CHANGE,)),
    # A month name inside a value is not a month.
    G("Show me the logs for host jan-laptop", tools=("search_logs",), max_lookups=1,
      params=(P("search_logs", host="jan-laptop", window=None),)),
    G("Investigate everything about host dec-web01", tools=("search_logs", "log_stats"), min_lookups=10,
      params=(P("search_logs", host="dec-web01", time_from="now-30d"),), forbid=(P("case_stats", window="now-12M"),),
      may_fail=("lookup_indicator",), notices=("denied", "policy")),
    G("Search logs for SEP", tools=("search_logs",), max_lookups=1,
      params=(P("search_logs", contains="SEP", window=None),)),
    # Product questions that mention a period run no data lookup.
    G("How do I create a report for September?", kind="product_help", tools=("app_help",), max_lookups=1),
    G("Where do I see the Q3 numbers?", kind="product_help", tools=("app_help",), max_lookups=1),
    G("Give me the Q3 numbers", tools=("case_stats", "soc_metrics"),
      params=(P("case_stats", window=r"re:^\d{4}-Q3$"), P("soc_metrics", kind="posture", window=r"re:^\d{4}-Q3$"))),
    # A true/false-positive count keeps its comparison.
    G("How many false positives did we have this month compared to last month?", tools=("case_stats",),
      params=(P("case_stats", verdict="FALSE_POSITIVE", window="this_month", compare="previous_period"),),
      contains=(_COMPARED,)),
    G("How many true positives this week vs last week?", tools=("case_stats",),
      params=(P("case_stats", verdict="TRUE_POSITIVE", window="this_week", compare="previous_period"),),
      contains=(_COMPARED,)),
    # Everyday period questions are data answers.
    G("How did we do this week?", tools=("soc_metrics",),
      params=(P("soc_metrics", kind="posture", window="this_week"),)),
    G("What happened in the last 2 weeks?", tools=("case_stats", "soc_metrics"),
      params=(P("case_stats", window="now-2w"), P("soc_metrics", kind="posture", window="now-2w"))),
    G("Can I get the stats for March 2026?", tools=("case_stats",), params=(P("case_stats", window="2026-03"),),
      figures=(Fig("**{n} cases**", "2026-03", zero="No case was opened in March 2026"),)),
    # Minutes stay minutes for logs; case lookups say they count whole hours.
    G("How many cases in the last 30 minutes?", tools=("case_stats",), params=(P("case_stats", window="now-1h"),),
      contains=("Case, metric and cost lookups count whole hours",)),
    G("Search logs for mimikatz in the last 30 minutes", tools=("search_logs",),
      params=(P("search_logs", contains="mimikatz", window="now-30m"),)),
    # A trend over an open or ISO range is bucketed by a sensible unit, never by hour.
    G("Case volume trend since August", tools=("case_stats",), forbid=(P("case_stats", bucket="hour"),),
      params=(P("case_stats", bucket="re:^(?:day|week|month)$", window=r"re:\d{4}-08-01"),)),
    G("Show the case trend from 2026-08-01 to 2026-09-30", tools=("case_stats",),
      forbid=(P("case_stats", bucket="hour"),), params=(P("case_stats", bucket="week"),)),
]

#: Regressions from the second WP-DEMO review (R2-n is the finding number).
_AI_CLOSED = {"status_group": "terminal", "decided_by": "agent"}
_TP_RATE = r"re:\ATrue-positive rate(?: \*\*\d|: not measured)"
REGRESSIONS_R2 = [
    # R2-2: day-level and rolling-span comparisons.
    G("Compare today with yesterday", tools=("case_stats", "soc_metrics"),
      params=(P("case_stats", window="today", compare="previous_period"),), absent=("I could not map",)),
    G("How does today compare to yesterday?", tools=("case_stats",),
      params=(P("case_stats", window="today", compare="previous_period"),)),
    G("How many cases today vs yesterday?", tools=("case_stats",),
      params=(P("case_stats", window="today", compare="previous_period"),)),
    G("How many medium cases today compared to yesterday?", tools=("case_stats",),
      params=(P("case_stats", window="today", compare="previous_period", severity="medium"),)),
    G("Compare the last 30 days with the 30 days before", tools=("case_stats", "soc_metrics"),
      params=(P("case_stats", window="now-30d", compare="previous_period"),)),
    G("Compare yesterday and today", tools=("case_stats",),
      params=(P("case_stats", window="today", compare="previous_period"),)),
    # R2-3: a filtered comparison names its filter and leaves out the all-case posture.
    G("Compare critical cases this month vs last month", tools=("case_stats",),
      params=(P("case_stats", window="this_month", compare="previous_period", severity="critical"),
              P("case_stats", group_by="verdict", severity="critical")), forbid=(P("soc_metrics"),),
      contains=(r"re:\A\*\*Critical cases, .+ compared with .+\*\* \(changes computed exactly\):",
                r"re:^- Critical cases: \*\*\d"), absent=("over every case", "Automation rate")),
    G("How many cases for user pnair this week vs last week?", tools=("case_stats",),
      params=(P("case_stats", window="this_week", compare="previous_period", entity="pnair"),),
      forbid=(P("soc_metrics"),), contains=(r"re:\A\*\*Cases involving `pnair`, ",),
      absent=("over every case", "Automation rate")),
    G("How many escalated cases this week compared to last week?", tools=("case_stats",),
      params=(P("case_stats", window="this_week", compare="previous_period", status="escalated"),),
      contains=(r"re:\A\*\*Escalated cases, ",), absent=("over every case",)),
    # R2-12: two past periods never call the later one "now".
    G("Compare August 2026 and September 2026 automation", tools=("case_stats", "soc_metrics"),
      params=(P("soc_metrics", kind="posture", window="2026-09", compare="2026-08"),),
      contains=(r"re:Automation rate: .+ in Sep 2026\)\.",), absent=("now)",)),
    # R2-5: the true-positive rate leads its answer.
    G("What is our TP rate?", tools=("case_stats",), params=(P("case_stats", metrics="re:tp_rate"),),
      contains=(_TP_RATE,)),
    G("What's the TP rate over all time?", tools=("case_stats",),
      params=(P("case_stats", metrics="re:tp_rate", window="all"),), contains=(_TP_RATE,)),
    G("TP rate this quarter", tools=("case_stats",),
      params=(P("case_stats", metrics="re:tp_rate", window="this_quarter"),), contains=(_TP_RATE,)),
    G("What is our true positive rate this month?", tools=("case_stats",),
      params=(P("case_stats", metrics="re:tp_rate", window="this_month"),), contains=(_TP_RATE,),
      figures=(Fig("over {n} cases", "this_month", zero="where no case was opened"),)),
    G("True positive rate last month", tools=("case_stats",),
      params=(P("case_stats", metrics="re:tp_rate", window="last_month"),), contains=(_TP_RATE,)),
    # R2-6: period summaries, the AI's closes and cases by entity.
    G("Summarize the last 24 hours", tools=("case_stats", "soc_metrics", "search_cases"),
      params=(P("case_stats", window="now-24h"), P("soc_metrics", kind="posture", window="now-24h"))),
    G("Give me a summary of last month", tools=("case_stats", "soc_metrics", "search_cases"),
      params=(P("case_stats", window="last_month"),), figures=(Fig("**{n} cases**", "last_month"),)),
    G("How many cases did the AI close this month?", tools=("case_stats",),
      params=(P("case_stats", status_group="terminal", window="this_month", metrics="re:auto_closed"),),
      figures=(Fig("**{n} cases** opened in", "this_month", _AI_CLOSED),
               Fig("of {n} closed cases", "this_month", _TERMINAL))),
    G("How many cases were auto-closed last week?", tools=("case_stats",),
      params=(P("case_stats", status_group="terminal", window="last_week", metrics="re:auto_closed"),),
      figures=(Fig("**{n} cases** opened last week were closed automatically", "last_week", _AI_CLOSED,
                   zero="No closed case matched last week"),)),
    G("Which users had the most cases this quarter?", tools=("search_cases", "case_stats"),
      params=(P("search_cases", window="this_quarter"), P("case_stats", window="this_quarter", entity="re:.")),
      forbid=(P("log_stats"),), contains=("(exact)",)),
    # R2-9: the automation-rate trend is its own measure.
    G("What's the automation rate trend by month?", tools=("case_stats",),
      params=(P("case_stats", bucket="month", metrics="re:auto_closed"),),
      contains=(r"re:\A\*\*Automation rate ",), absent=("False-positive rate per", "True-positive rate per")),
    # R2-10: a second grouping and a top N.
    G("Open cases by severity and assignee", tools=("case_stats",),
      params=(P("case_stats", group_by="severity,assignee", status_group="active"),),
      contains=("By severity, then assignee:",)),
    G("Top 5 rules this month", tools=("log_stats",), params=(P("log_stats", group_by="rule", top_n=5),)),
    G("Cases by month and severity", tools=("case_stats",),
      params=(P("case_stats", bucket="month", group_by="severity"),), contains=("By severity over the whole window:",)),
    # R2-8: an unrelated campaign is never part of an entity's investigation.
    G("Investigate everything about host dc01 over the last quarter", tools=("log_stats", "search_logs"),
      min_lookups=10, may_fail=("lookup_indicator",), notices=("denied", "policy"),
      absent=("sharing user",)),
    # R2-13: a named period wholly outside the chip is refused and said, never answered with the chip.
    G("How many cases were opened in March 2026?", tools=(), may_fail=("case_stats",), fields=_CHIP_90D,
      contains=("March 2026 is outside the last 90 days you selected",), absent=("**",)),
    # Final review (L2): "whole year" is this year, never the last 30 days with a
    # false "No period was named"; an unreadable period is named as unread.
    G("Make a report for the whole year", tools=("case_stats", "soc_metrics"), report=True, sections=6,
      title=rf"^SOC performance report, {_NOW.year}$",
      params=(P("case_stats", window="this_year"), P("soc_metrics", kind="posture", window="this_year")),
      absent=("No period was named", "last 30 days"), figures=(Fig("**{n} cases**", "this_year"),)),
    G("make a report for this whole year", tools=("case_stats", "soc_metrics"), report=True,
      title=rf"^SOC performance report, {_NOW.year}$", params=(P("case_stats", window="this_year"),),
      absent=("No period was named",)),
    G("Make a full-year report", tools=("case_stats", "soc_metrics"), report=True,
      title=rf"^SOC performance report, {_NOW.year}$", params=(P("case_stats", window="this_year"),),
      absent=("No period was named", "last 30 days")),
    G("Make a report for the fiscal year", tools=("case_stats", "soc_metrics"), report=True,
      title=r"last 30 days$", contains=("I could not read “for the fiscal year” as a period",),
      absent=("No period was named",)),
    # Final review (L2): "<field> wise" breakdowns, as "month wise" already was.
    G("Segregate the open cases severity wise", tools=("case_stats",),
      params=(P("case_stats", group_by="severity", status_group="active"),), contains=("By severity:",),
      figures=(Fig("**{n} cases are open right now**", None, _ACTIVE),)),
    G("Segregate open cases according to severity", tools=("case_stats",),
      params=(P("case_stats", group_by="severity", status_group="active"),), contains=("By severity:",)),
    G("Show the closed cases verdict wise this month", tools=("case_stats",),
      params=(P("case_stats", group_by="verdict", status_group="terminal", window="this_month"),)),
    # Final review (L2): a share of the AI's closes states the rate, never a case list.
    G("What percentage of cases were auto closed all time", tools=("case_stats",),
      params=(P("case_stats", status_group="terminal", window="all", metrics="re:auto_closed"),),
      forbid=(P("search_cases"),),
      contains=(r"re:\A\*\*\d+(?:\.\d)?%\*\* of the closed cases were closed automatically by the AI agent",
                "This is the automation rate."),
      figures=(Fig(": {n} of", "all", _AI_CLOSED),)),
    G("Share the auto closed cases with me", tools=("search_cases",), forbid=(P("case_stats"),),
      absent=("automation rate",)),
    G("What share of cases did the AI close this month?", tools=("case_stats",),
      params=(P("case_stats", status_group="terminal", window="this_month", metrics="re:auto_closed"),),
      forbid=(P("search_cases"),), contains=(r"re:\A\*\*(?:\d+(?:\.\d)?%\*\* of the closed cases|No )",)),
    # Final review round 2 (L2): a period named anywhere in the question beats a
    # whole/full phrase; a period after "on"/"the" is read; a period word no rule reads
    # is named, never "No period was named".
    G("Make a full-year report for last year", tools=("case_stats", "soc_metrics"), report=True,
      title=rf"^SOC performance report, {_NOW.year - 1}$",
      params=(P("case_stats", window="last_year"), P("soc_metrics", kind="posture", window="last_year")),
      forbid=(P("case_stats", window="this_year"),), absent=("No period was named",)),
    G("Make a full year report for 2025", tools=("case_stats", "soc_metrics"), report=True,
      title=r"^SOC performance report, 2025$", params=(P("case_stats", window="2025"),),
      forbid=(P("case_stats", window="this_year"),)),
    G("Make a whole week report for last week", tools=("case_stats", "soc_metrics"), report=True,
      params=(P("case_stats", window="last_week"),), forbid=(P("case_stats", window="this_week"),),
      absent=("No period was named",)),
    G("Make a report on the year", tools=("case_stats", "soc_metrics"), report=True,
      title=rf"^SOC performance report, {_NOW.year}$", params=(P("case_stats", window="this_year"),),
      absent=("No period was named", "last 30 days")),
    G("Make a report on the calendar year", tools=("case_stats", "soc_metrics"), report=True,
      title=rf"^SOC performance report, {_NOW.year}$", params=(P("case_stats", window="this_year"),),
      absent=("No period was named",)),
    G("Make a report on the weekend", tools=("case_stats", "soc_metrics"), report=True, title=r"last 30 days$",
      contains=("I could not read “on the weekend” as a period",), absent=("No period was named",)),
    G("Segregate cases on the basis of severity", tools=("case_stats",),
      params=(P("case_stats", group_by="severity"),), forbid=(P("search_cases"),), contains=("By severity:",),
      figures=(Fig("**{n} cases**", "all"),)),
    # Final review round 2 (L2): a filtered auto-close share names its cases and is not
    # the automation rate; a cost share stays a cost question; a share per period is the
    # automation-rate trend; a share WITHIN the AI's closes is computed from its groups.
    G("What percentage of critical cases were auto closed", tools=("case_stats",),
      params=(P("case_stats", status_group="terminal", severity="critical", metrics="re:auto_closed"),),
      contains=(r"re:\A\*\*\d+(?:\.\d)?%\*\* of the closed critical cases were closed automatically",),
      absent=("automation rate",),
      figures=(Fig(": {n} of", None, {**_AI_CLOSED, "severity": "critical"}, zero=": 0 of"),)),
    G("What percentage of false positive cases were auto closed", tools=("case_stats",),
      params=(P("case_stats", status_group="terminal", verdict="FALSE_POSITIVE", metrics="re:auto_closed"),),
      contains=(r"re:\A\*\*\d+(?:\.\d)?%\*\* of the closed false positive cases",), absent=("automation rate",),
      figures=(Fig(": {n} of", None, {**_AI_CLOSED, "verdict": "FALSE_POSITIVE"}, zero=": 0 of"),)),
    G("How much of the cost went to auto closed cases", tools=("cost_usage",), forbid=(P("case_stats"),),
      absent=("automation rate",)),
    G("Auto close percentage per month", tools=("case_stats",),
      params=(P("case_stats", bucket="month", metrics="re:auto_closed"),),
      contains=(r"re:\A\*\*Automation rate ", "Automation rate per month:")),
    G("What percentage of auto closed cases were false positives", tools=("case_stats",),
      params=(P("case_stats", group_by="verdict", status_group="terminal", metrics="re:auto_closed"),),
      contains=(r"re:\A\*\*\d+(?:\.\d)?%\*\* of the \d+ cases that the AI agent closed .*were false positives: ",),
      absent=("This is the automation rate",),
      figures=(Fig("were false positives: {n} of", None, {**_AI_CLOSED, "verdict": "FALSE_POSITIVE"},
                   zero="were false positives: 0 of"),)),
]

# Final review round 3 (L3, held): a data request that also says "explain" (or "what
# are") is a data request. The bare word never routes it to the Help Center ("Product
# help" with a KPI glossary entry and no case list was the operator's glitch); only a
# definitional ask does ("Explain the false positive rate", "what each level means").
_NO_HELP = (P("app_help"),)
#: A list of records is never answered as a count, and never from the Help Center.
_NOT_COUNTED = (*_NO_HELP, P("case_stats"))
#: Each listed case explained, or (an empty window) the zero result saying so.
_EXPLAINED = r"re:^Case by case:$|^No .+ matched"
EXPLAIN_RECORDS = [
    G("Show the top 10 open cases by risk with a table and explain each", tools=("search_cases",),
      params=(P("search_cases", status_group="active", sort_field="risk_score", limit=10),),
      forbid=_NO_HELP, contains=("Highest risk first.", "Case by case:"), absent=("From the Help Center",),
      figures=(Fig("**{n} open case", None, _ACTIVE),)),
    G("List the open critical cases and explain why each one is critical", tools=("search_cases",),
      params=(P("search_cases", status_group="active", severity="critical"),), forbid=_NO_HELP,
      absent=("From the Help Center",),
      figures=(Fig("**{n} open critical case", None, {**_ACTIVE, "severity": "critical"},
                   zero="No open critical case"),)),
    G("Which cases had the highest risk this week? Explain the top 3", tools=("search_cases",),
      params=(P("search_cases", window="this_week", sort_field="risk_score", limit=3, severity=None),),
      forbid=_NO_HELP, absent=("From the Help Center",),
      figures=(Fig("**{n} case", "this_week", zero="No case matched"),)),
    G("List false positives this week and explain each", tools=("search_cases",),
      params=(P("search_cases", verdict="FALSE_POSITIVE", window="this_week"),),
      forbid=(*_NO_HELP, P("soc_metrics")), absent=("From the Help Center",),
      figures=(Fig("**{n} false positive case", "this_week", {"verdict": "FALSE_POSITIVE"},
                   zero="No false positive case matched"),)),
    # Near variants: the same request in other words.
    G("Top 5 critical cases, explain each", tools=("search_cases",),
      params=(P("search_cases", severity="critical", limit=5),), forbid=_NO_HELP,
      figures=(Fig("**{n} critical case", None, {"severity": "critical"}, zero="No critical case"),)),
    G("What are the open critical cases?", tools=("search_cases",),
      params=(P("search_cases", status_group="active", severity="critical"),), forbid=_NO_HELP),
    G("What are the highest risk cases this week?", tools=("search_cases",),
      params=(P("search_cases", window="this_week", sort_field="risk_score", severity=None),), forbid=_NO_HELP),
    G("Explain each of the escalated cases", tools=("search_cases",),
      params=(P("search_cases", status="escalated"),), forbid=_NO_HELP),
    G("Which incidents are open? Explain them", tools=("search_cases",),
      params=(P("search_cases", status_group="active"),), forbid=_NO_HELP),
    G("Show false positives this week", tools=("search_cases",),
      params=(P("search_cases", verdict="FALSE_POSITIVE", window="this_week"),), forbid=_NO_HELP),
    G("List true positives this month and explain each", tools=("search_cases",),
      params=(P("search_cases", verdict="TRUE_POSITIVE", window="this_month"),), forbid=_NO_HELP),
    G("Can you show me the open cases and explain them?", tools=("search_cases",),
      params=(P("search_cases", status_group="active"),), forbid=_NO_HELP),
    G("Explain the highest risk open cases", tools=("search_cases",),
      params=(P("search_cases", status_group="active", sort_field="risk_score"),), forbid=_NO_HELP),
    # A window beside the records lists them over that window (ranked as asked) and
    # explains each one; "each" and "every" there name the records, never a count.
    G("Show the top 10 open cases this week by risk with a table and explain each", tools=("search_cases",),
      params=(P("search_cases", status_group="active", window="this_week", sort_field="risk_score", limit=10),),
      forbid=_NOT_COUNTED, contains=(_EXPLAINED,), figures=(Fig("**{n} open case", "this_week", _ACTIVE),)),
    G("Which cases were escalated this week? Explain each", tools=("search_cases",),
      params=(P("search_cases", status="escalated", window="this_week"),), forbid=_NOT_COUNTED,
      contains=(_EXPLAINED,), figures=(Fig("**{n} escalated case", "this_week", {"status": "escalated"}),)),
    G("List the open critical cases this week and explain why each one is critical", tools=("search_cases",),
      params=(P("search_cases", status_group="active", severity="critical", window="this_week"),),
      forbid=_NOT_COUNTED, contains=(_EXPLAINED,),
      figures=(Fig("**{n} open critical case", "this_week", {**_ACTIVE, "severity": "critical"}),)),
    G("Show the escalated cases from today and explain each", tools=("search_cases",),
      params=(P("search_cases", status="escalated", window="today"),), forbid=_NOT_COUNTED,
      contains=(_EXPLAINED,), figures=(Fig("**{n} escalated case", "today", {"status": "escalated"}),)),
    G("List cases opened yesterday and explain each", tools=("search_cases",),
      params=(P("search_cases", window="yesterday"),), forbid=_NOT_COUNTED, contains=(_EXPLAINED,),
      figures=(Fig("**{n} case", "yesterday"),)),
    G("Show the critical cases this month and explain each of them", tools=("search_cases",),
      params=(P("search_cases", severity="critical", window="this_month"),), forbid=_NOT_COUNTED,
      contains=(_EXPLAINED,), figures=(Fig("**{n} critical case", "this_month", {"severity": "critical"}),)),
    G("Show me every open case from the last 24 hours", tools=("search_cases",),
      params=(P("search_cases", status_group="active", window="now-24h"),), forbid=_NOT_COUNTED,
      figures=(Fig("**{n} open case", "now-24h", _ACTIVE),)),
    G("List each critical case this week", tools=("search_cases",),
      params=(P("search_cases", severity="critical", window="this_week"),), forbid=_NOT_COUNTED,
      figures=(Fig("**{n} critical case", "this_week", {"severity": "critical"}),)),
    # "The first 3" and "the 5 riskiest" set the list's length.
    G("Explain the first 3 cases by risk", tools=("search_cases",),
      params=(P("search_cases", sort_field="risk_score", limit=3),), forbid=_NOT_COUNTED,
      contains=("Highest risk first.", _EXPLAINED)),
    G("Show me the 5 riskiest cases and explain each", tools=("search_cases",),
      params=(P("search_cases", sort_field="risk_score", limit=5),), forbid=_NOT_COUNTED,
      contains=("Highest risk first.", _EXPLAINED)),
    # Definitional asks keep their Help Center answer (with our own figure for a KPI).
    G("Explain the false positive rate", kind=("mixed", "product_help"), tools=("app_help", "soc_metrics"),
      params=(P("soc_metrics", kind="posture"),), forbid=(P("search_cases"),)),
    G("Explain what each severity level means", kind="product_help", tools=("app_help",), max_lookups=1),
    # A console term after the record ("each case status") or no record at all ("each
    # of the verdicts", "the first 3 steps") is a product question, never a case list.
    *(G(q, kind="product_help", tools=("app_help",), max_lookups=1, forbid=(P("search_cases"),))
      for q in ("Explain each case status", "Explain every case status", "Explain each alert severity",
                "Explain each incident severity", "Explain each case verdict", "Explain each case priority",
                "Explain each case outcome", "Explain every alert field", "Explain each incident lifecycle state",
                "Explain each of the case statuses", "Explain the top 3 tabs in case detail",
                "Explain each of the verdicts", "Explain each one of the verdicts", "Explain each of the roles",
                "Explain each ticket state", "Explain each detection rule type",
                "Explain the first 3 steps of onboarding", "Explain the first 2 steps of the setup wizard")),
]

# Final review round 4 (L4, demo planner): a request chat is not for gets an honest answer
# about what chat can do, with no lookup. Never the orientation case list, an unrelated
# Help Center passage, a console page that cannot do it, or a data refusal ("unsupported").
_SCOPE = "Chat answers questions about your security data (cases, logs, metrics, threat intelligence"
_CANT_ACT = "I can't do that: chat is read-only, and this console has no response actions"
_UNRELATED = ("open case", "From the Help Center", "I could not map", "Do it in the console", "Open it in the console",
              "Correlation across sources", "narrow composer", "KPI glossary")
#: Help Center passages and console pages the seeded corpus returns for change requests
#: that are not about them ("Lock the case" once quoted the narrow-composer passage).
_UNRELATED_HELP = ("open case", "I could not map", "Correlation across sources", "narrow composer", "KPI glossary",
                   "first bootstrap", "Checkpoints and restart", "Shift handoff", "Overview › Standup",
                   "Export portable application state")
OUT_OF_SCOPE = [
    *(G(q, kind="conversation", max_lookups=0, contains=("I can't write code or scripts.", _SCOPE), absent=_UNRELATED)
      for q in ("Write me a python script to scan my network", "Can you write a bash script that pings every host?",
                "Generate python code to parse the logs", "Please write a PowerShell one-liner to list services",
                "Build me a web page for our SOC")),
    *(G(q, kind="conversation", max_lookups=0, contains=("I can't write jokes, poems or stories.", _SCOPE),
        absent=_UNRELATED)
      for q in ("Tell me a joke", "Write a poem about phishing", "Tell me a funny story")),
    # Response actions: none exists in this console, so it says where they run and offers
    # to investigate the values the analyst named.
    *(G(q, kind="product_help", max_lookups=0, contains=(_CANT_ACT, "EDR, firewall or SOAR tool"), absent=_UNRELATED)
      for q in ("Isolate host srv-db-01 and block IP 203.0.113.77", "Quarantine host srv-db-01",
                "Block IP 203.0.113.77", "Please contain the infected laptop", "Kill process 4242 on srv-db-01",
                "Add 203.0.113.77 to the block list", "Lock the account svc_backup", "Sinkhole evil.example")),
    G("Isolate host srv-db-01 and block IP 203.0.113.77 now", kind="product_help", max_lookups=0,
      contains=("Before you act, chat can investigate host `srv-db-01` and IP `203.0.113.77`",)),
    # A general-knowledge question: no Help Center section answers it, so chat says what it answers.
    G("What is the capital of France?", kind="product_help", tools=("app_help",), max_lookups=1,
      contains=(_SCOPE,), absent=("open case",)),
    # A console object is a change chat cannot make (never a response action), and a case
    # for the bot activity is a case, not code. A change answer quotes only a passage and a
    # console page about the change, or none: never one that merely shares a word with it.
    # (Its console pointer and passage are not "unrelated" here, unlike a refused request.)
    G("Kill the export job", kind="product_help", tools=("app_help",), max_lookups=1,
      contains=(_CANT_CHANGE, "**Analytics › Jobs**", "**Background jobs › Work that uses the job system**"),
      absent=_UNRELATED_HELP),
    G("Create a case for the bot activity", kind="product_help", tools=("app_help",), max_lookups=1,
      contains=(_CANT_CHANGE,), absent=_UNRELATED_HELP),
    *(G(q, kind="product_help", tools=("app_help",), max_lookups=1, contains=(_CANT_CHANGE,),
        absent=(*_UNRELATED_HELP, "From the Help Center", "Also see"))
      for q in ("Lock the case", "Restart the poller")),
    # The story of a case or a period is a question about it, never a refused story.
    G("Tell me the story of case demo-00000539-0004", tools=("get_case",),
      params=(P("get_case", case_id="demo-00000539-0004"),), absent=("I can't write",)),
    G("Tell me the story of this case", tools=("get_case",), fields={"case_id": "demo-00000539-0004"},
      contains=("**`demo-00000539-0004`**",), absent=("I can't write",)),
    G("Tell me the story of what happened today", any_of=("search_cases",), absent=("I can't write",)),
    # A response answer names only what reads as a host or user name, never "of" or "out".
    *(G(q, kind="product_help", max_lookups=0,
        contains=(_CANT_ACT, "Before you act, ask chat about the host, user or indicator involved"),
        absent=(*_UNRELATED, "`of`", "`out`", "Before you act, chat can investigate"))
      for q in ("Isolate the host of the attacker", "Lock the user out")),
]

# Closing review (demo planner finals): a year named on its own beats an implied period;
# "the year so far" is this year to date; a share within the AI's closes in any word
# order; a defining word about the listed records keeps the records; console parts are
# product questions; plain names after a kind word are offered; containing the damage is
# a response action; change answers keep the page their console-map keywords name; and a
# made-up story about a generic attack is fiction.
CLOSING = [
    *(G(q, tools=("case_stats", "soc_metrics"), report=True, title=rf"^SOC performance report, {year}$",
        params=(P("case_stats", window=year), P("soc_metrics", kind="posture", window=year)),
        forbid=(P("case_stats", window="this_year"), P("case_stats", window="last_year")))
      for q, year in (("End of year report 2025", "2025"), ("Make a full year report 2025", "2025"),
                      ("2024 annual report", "2024"))),
    G("Make a report for the year so far", tools=("case_stats", "soc_metrics"), report=True,
      title=rf"^SOC performance report, {_NOW.year} to date$", params=(P("case_stats", window="ytd"),),
      forbid=(P("case_stats", window="all"),)),
    G("what percentage of the cases the AI closed were medium severity", tools=("case_stats",),
      params=(P("case_stats", group_by="severity", status_group="terminal", metrics="re:auto_closed"),),
      contains=(r"re:\A\*\*\d+(?:\.\d)?%\*\* of the \d+ cases that the AI agent closed .*were medium severity: ",),
      absent=("This is the automation rate",),
      figures=(Fig("were medium severity: {n} of", None, {**_AI_CLOSED, "severity": "medium"},
                   zero="were medium severity: 0 of"),)),
    G("of the auto closed cases, what percentage were false positives", tools=("case_stats",),
      params=(P("case_stats", group_by="verdict", status_group="terminal", metrics="re:auto_closed"),),
      contains=(r"re:\A\*\*\d+(?:\.\d)?%\*\* of the \d+ cases that the AI agent closed .*were false positives: ",),
      figures=(Fig("were false positives: {n} of", None, {**_AI_CLOSED, "verdict": "FALSE_POSITIVE"},
                   zero="were false positives: 0 of"),)),
    *(G(q, tools=("search_cases",), forbid=(*_NO_HELP, P("case_stats")), absent=("From the Help Center",))
      for q in ("Show the escalated cases and explain what each one means",
                "Show today's critical alerts and explain what they mean",
                "List the open critical cases and explain what each means for us",
                "List the escalated cases and tell me what each one means")),
    *(G(q, kind="product_help", tools=("app_help",), max_lookups=1, forbid=(P("search_cases"),))
      for q in ("Explain each case action", "Explain every incident badge", "Explain each alert icon")),
    *(G(q, kind="product_help", max_lookups=0,
        contains=(_CANT_ACT, f"Before you act, chat can investigate {who}"), absent=_UNRELATED)
      for q, who in (("Lock user dsingh", "user `dsingh`"), ("Isolate host workstation", "host `workstation`"),
                     ("Contain the issue on host srv-db-01", "host `srv-db-01`"))),
    G("Contain the damage now", kind="product_help", max_lookups=0, contains=(_CANT_ACT,), absent=_UNRELATED),
    G("Change the theme to dark", kind="product_help", tools=("app_help",), max_lookups=1,
      contains=(_CANT_CHANGE, "Do it in the console: **Settings › Account › Appearance & customization**")),
    G("Change the case ID format", kind="product_help", tools=("app_help",), max_lookups=1,
      contains=(_CANT_CHANGE, "**Settings › General › Cases**")),
    *(G(q, kind="conversation", max_lookups=0, contains=("I can't write jokes, poems or stories.", _SCOPE),
        absent=_UNRELATED)
      for q in ("Make up a story about an intrusion", "Write a story about a phishing attack",
                "Tell me stories about cyber attacks")),
]

GOLDEN: list[G] = [*SCREENSHOT, *REPORTS, *CASE_COUNTS, *TRENDS, *COMPARISONS, *METRICS, *COST, *LOGS, *INTEL,
                   *CASES, *DEEP, *APP_HELP, *PLATFORM, *CLARIFY, *READ_ONLY, *REGRESSIONS, *REGRESSIONS_R2,
                   *EXPLAIN_RECORDS, *OUT_OF_SCOPE, *CLOSING]


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
#: The old 720-hour (30-day) clamp, as a window ("720h", "720 hours", "now-720h"); a
#: bare "720" substring would also match a cost or token count ("$0.0720", "1,720 tokens").
_CAPPED_720 = re.compile(r"\b720 ?h(?:ours?)?\b|now-720h", re.IGNORECASE)


def _match(expected: Any, actual: Any) -> bool:
    """One expected parameter value against a step's display value."""
    if expected is None:
        return actual is None
    if isinstance(expected, str) and expected.startswith("re:"):
        return actual is not None and re.search(expected[3:], str(actual)) is not None
    return actual is not None and str(actual) == str(expected)


def _has(params: dict[str, Any] | None, subset: dict[str, Any]) -> bool:
    params = params or {}
    return all(_match(value, params.get(key)) for key, value in subset.items())


def _matched_step(steps: list[dict[str, Any]], tool: str, subset: dict[str, Any]) -> dict[str, Any] | None:
    return next((s for s in steps if s["tool"] == tool and s.get("status") == "ok" and _has(s.get("params"), subset)),
                None)


def _check(g: G, response: dict[str, Any], client: TestClient | None = None) -> None:
    answer = response.get("answer") or ""
    steps = _tool_steps(response)
    ok = {s["tool"] for s in steps if s.get("status") == "ok"}
    data_steps = [s for s in steps if s["tool"] not in _REFERENCE]
    context = (g.q, answer[:600], [(s["tool"], s.get("status"), s.get("params"), s.get("summary")) for s in steps])
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
    if g.max_lookups is not None:
        assert len(steps) <= g.max_lookups, (len(steps), context)
    # The lookups asked the question that was asked: its window, filters and grouping.
    for tool, subset in g.params:
        assert _matched_step(steps, tool, subset) is not None, (tool, subset, context)
    for tool, subset in g.forbid:
        assert _matched_step(steps, tool, subset) is None, ("forbidden", tool, subset, context)
    for text in g.contains:
        if text.startswith("re:"):
            assert re.search(text[3:], answer, re.MULTILINE), (text, context)
        else:
            assert text in answer, (text, context)
    for text in g.absent:
        assert text not in answer, (text, context)
    # "Product help" is shown only for answers about the console (SPEC D9).
    kind = response.get("answer_kind")
    if kind == "product_help":
        assert not data_steps, context
    if g.kind != "any":
        expected = g.kind if isinstance(g.kind, tuple) else (g.kind,)
        assert kind in expected, (kind, context)
    if kind in ("data", "mixed"):
        assert data_steps, context
        # Figures or blocks; a zero result says what was searched ("No … matched").
        assert response.get("blocks") or re.search(r"\d", answer) or answer.startswith("No "), context
    # Exact aggregates: no figure presented as a sample bound, no window capped to 30 days.
    for step in data_steps:
        summary = (step.get("summary") or "").lower()
        assert "capped" not in summary and not _CAPPED_720.search(summary), context
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
        if g.title:
            # The saved title names the subject and the period that was asked for.
            assert re.search(g.title, saved.get("title") or ""), (saved.get("title"), g.title, context)
    else:
        assert saved is None, context
    # The figures the answer states equal a direct count of the case store.
    if g.figures:
        assert client is not None
        for fig in g.figures:
            n = _store_count(client, _figure_window(fig, g, steps), fig.filters)
            expected = fig.text.format(n=f"{n:,}")
            assert expected in answer or (n == 0 and fig.zero in answer), (expected, n, context)


def _figure_window(fig: Fig, g: G, steps: list[dict[str, Any]]) -> Any:
    """The window a figure is counted over: its own, or the window the matched step sent."""
    if not (isinstance(fig.window, str) and fig.window.startswith("step:")):
        return fig.window
    tool = fig.window[len("step:"):]
    subset = next(sub for name, sub in g.params if name == tool)
    step = _matched_step(steps, tool, subset)
    assert step is not None, (tool, subset)
    raw = (step.get("params") or {}).get("window")
    return json.loads(raw) if isinstance(raw, str) and raw.startswith("{") else raw


def _store_cases(client: TestClient) -> list[Any]:
    """Every case in the demo store (a direct read, not through a chat tool)."""
    async def read() -> list[Any]:
        store = _state(client).cases
        out: list[Any] = []
        seen: set[str] = set()
        cursor: Any = None
        for _page in range(1_000):
            rows, cursor, _snapshot, _consistency = await store.export_page(limit=500, cursor=cursor)
            fresh = [case for case in rows if case.case_id not in seen]
            seen.update(case.case_id for case in fresh)
            out.extend(fresh)
            if cursor is None or not rows:
                break
        return out

    return client.portal.call(read)  # type: ignore[union-attr]


def _store_count(client: TestClient, window: Any, filters: dict[str, str]) -> int:
    """Cases created in ``window`` (half-open, like the aggregator) matching ``filters``."""
    from app.constants import OPEN_CASE_STATUSES, TERMINAL_CASE_STATUSES
    from app.engine.priority import band_of_case
    from app.engine.time_windows import resolve_window

    resolved = None if window in (None, "all") else resolve_window(window, tz="UTC")
    prefs = _state(client).prefs
    count = 0
    for case in _store_cases(client):
        if resolved is not None:
            try:
                created = datetime.fromisoformat(str(case.created_at))
            except ValueError:
                continue
            if created.tzinfo is None:
                created = created.replace(tzinfo=UTC)
            if resolved.start is not None and created < resolved.start:
                continue
            if not resolved.open_end and created >= resolved.end:
                continue
        status = str(getattr(case.status, "value", case.status))
        if filters.get("status_group") == "active" and status not in OPEN_CASE_STATUSES:
            continue
        if filters.get("status_group") == "terminal" and status not in TERMINAL_CASE_STATUSES:
            continue
        if "status" in filters and status != filters["status"]:
            continue
        if "verdict" in filters and str(getattr(case.verdict, "value", case.verdict)) != filters["verdict"]:
            continue
        if "severity" in filters and band_of_case(case, prefs) != filters["severity"]:
            continue
        if "decided_by" in filters:
            # Closed by the AI agent: its decider, never an analyst-policy close.
            from app.engine.precedent import is_policy_closed

            if str(getattr(case.decision_by, "value", case.decision_by)) != filters["decided_by"]:
                continue
            if is_policy_closed(case):
                continue
        count += 1
    return count


@pytest.mark.parametrize("g", GOLDEN, ids=[re.sub(r"[^a-z0-9]+", "-", g.q.lower())[:60] for g in GOLDEN])
def test_golden_question_answers_end_to_end(client: TestClient, g: G) -> None:
    fields: dict[str, Any] = dict(g.fields)
    if g.report:
        # A report is saved from the PERSISTED answer (SPEC D11): a Workspace conversation.
        fields.update(persist_conversation=True, idempotency_key=_key("report", g.q))
    _check(g, _stream(client, g.q, **fields), client)


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
    assert _has(step["params"], {"window": "all", "bucket": "month"})
    # The rerun names the window that actually ran (never the old "last 1 day").
    assert second["answer"].startswith("Re-ran the earlier lookups for all time:")
    assert "No case matched" not in second["answer"] and "last 1 day" not in second["answer"]


ZERO_QUESTION = "How many critical false positives this week?"


@pytest.mark.parametrize("follow, subset, said", [
    ("Show the same for all time", {"window": "all", "verdict": "FALSE_POSITIVE", "severity": "critical"},
     "for all time"),
    ("Show the same without the verdict filter", {"window": "this_week", "verdict": None, "severity": "critical"},
     "without the verdict filter"),
    ("Show the same without the severity filter",
     {"window": "this_week", "verdict": "FALSE_POSITIVE", "severity": None}, "without the severity filter"),
])
def test_each_zero_result_suggestion_reruns_the_lookup(client: TestClient, follow: str, subset: dict[str, Any],
                                                       said: str) -> None:
    """SYNTHESIS P0-11: a filtered zero result offers at least two suggestions, and
    each one runs as a valid lookup whose answer states what actually ran."""
    first = _stream(client, ZERO_QUESTION, persist_conversation=True, idempotency_key=_key("zero3", follow, "1"))
    assert first["answer"].startswith("No critical false positive case matched this week."), first["answer"]
    assert len(first["follow_ups"]) >= 2 and follow in first["follow_ups"]
    second = _stream(client, follow, origin="follow_up", persist_conversation=True,
                     conversation_id=first["conversation_id"], idempotency_key=_key("zero3", follow, "2"))
    (step,) = _tool_steps(second)
    assert step["tool"] == "case_stats" and step["status"] == "ok" and _has(step["params"], subset), step
    assert second["answer"].startswith(f"Re-ran the earlier lookups {said}:"), second["answer"]
    assert "last 1 day" not in second["answer"]


@pytest.mark.parametrize("question", ["Can I get the stats for March 2026?", "What happened in March 2026?"])
def test_a_period_summary_chip_reruns_as_the_same_summary(client: TestClient, question: str) -> None:
    """R2-1: the zero-result chip under a period summary re-runs the summary over all
    time and keeps its shape: the posture figures stay, the riskiest true positives are
    listed as true positives (never as "the oldest still open"), sorted and limited as
    the summary asked."""
    first = _stream(client, question, persist_conversation=True, idempotency_key=_key("r2-1", question, "1"))
    assert first["answer"].startswith("No case was opened in March 2026."), first["answer"]
    assert "Show the same for all time" in first["follow_ups"]
    second = _stream(client, "Show the same for all time", origin="follow_up", persist_conversation=True,
                     conversation_id=first["conversation_id"], idempotency_key=_key("r2-1", question, "2"))
    answer = second["answer"]
    steps = _tool_steps(second)
    assert answer.startswith("Re-ran the earlier lookups for all time:"), answer
    assert "oldest still open" not in answer and "next oldest" not in answer, answer
    assert re.search(r"^False-positive rate \*\*", answer, re.MULTILINE), answer
    assert re.search(r"^\*\*\d+ true positives\*\*", answer, re.MULTILINE), answer
    assert _matched_step(steps, "search_cases", {"verdict": "TRUE_POSITIVE", "window": "all",
                                                 "sort_field": "risk_score", "limit": "5"}) is not None, steps
    titles = [b.get("title") for b in second["blocks"]]
    assert "Oldest open cases" not in titles and "Riskiest true positives" in titles, titles
    assert "Compare all time with the period before" not in second["follow_ups"]
    truth = _store_count(client, "all", {})
    assert f"**{truth:,} cases** over all time" in answer


def test_an_oldest_open_chip_rerun_keeps_the_oldest_first_list(client: TestClient) -> None:
    """R2-1: a breakdown of OPEN cases by month re-run over all time still lists the
    oldest open cases first (the digest does not carry the sort order)."""
    first = _stream(client, "How many cases opened in 2024 are still open, by month?", persist_conversation=True,
                    idempotency_key=_key("r2-1b", "1"))
    assert first["answer"].startswith("No open case matched in 2024."), first["answer"]
    second = _stream(client, "Show the same for all time", origin="follow_up", persist_conversation=True,
                     conversation_id=first["conversation_id"], idempotency_key=_key("r2-1b", "2"))
    steps = _tool_steps(second)
    assert _matched_step(steps, "case_stats", {"status_group": "active", "window": "all", "bucket": "month"}), steps
    listed = _matched_step(steps, "search_cases", {"status_group": "active", "sort_field": "created_at", "limit": "5"})
    assert listed is not None and "listing the 5 oldest" in listed["summary"], steps
    assert "The oldest still open is" in second["answer"], second["answer"]


#: Each clarify option (SPEC D10) and the lookup its pick must run.
CLARIFY_PICKS: list[tuple[str, str, str, dict[str, Any]]] = [
    ("trend", "Alerts", "log_stats", {"time_from": "now-30d"}),
    ("trend", "Cases", "case_stats", {"bucket": "day", "window": "now-30d"}),
    ("trend", "AI cost", "cost_usage", {"bucket": "day", "window": "now-30d"}),
    ("trend", "FP rate", "case_stats", {"bucket": "week", "metrics": "re:fp_rate"}),
    ("compare", "This month vs last month", "case_stats", {"window": "this_month", "compare": "previous_period"}),
    ("compare", "This week vs last week", "case_stats", {"window": "this_week", "compare": "previous_period"}),
    ("compare", "This quarter vs last quarter", "case_stats", {"window": "this_quarter", "compare": "previous_period"}),
    ("compare", "This month vs the same month last year", "case_stats",
     {"window": "this_month", "compare": "same_period_last_year"}),
    ("count", "Open cases", "search_cases", {"status_group": "active"}),
    ("count", "Cases this week", "case_stats", {"window": "this_week"}),
    ("count", "Alerts in the last 24 hours", "log_stats", {"time_from": "now-24h"}),
    ("count", "AI spend today", "cost_usage", {"window": "today"}),
    ("breakdown", "Cases by month", "case_stats", {"bucket": "month"}),
    ("breakdown", "Cases by severity", "case_stats", {"group_by": "severity"}),
    ("breakdown", "Alerts by host", "log_stats", {"group_by": "host"}),
    ("breakdown", "AI spend by model", "cost_usage", {"group_by": "model"}),
]
_CLARIFY_QUESTIONS = {"trend": "show me the trend", "compare": "compare", "count": "how many?",
                      "breakdown": "break it down"}


def test_every_clarify_option_is_covered() -> None:
    from app.engine.demo_chat import CLARIFY_OPTIONS

    offered = {(kind, option) for kind, (_question, options) in CLARIFY_OPTIONS.items() for option in options}
    assert offered == {(kind, option) for kind, option, _tool, _subset in CLARIFY_PICKS}


@pytest.mark.parametrize("kind, option, tool, subset", CLARIFY_PICKS,
                         ids=[f"{k}-{o}".lower().replace(" ", "-") for k, o, _t, _s in CLARIFY_PICKS])
def test_every_clarify_option_answers_what_it_names(client: TestClient, kind: str, option: str, tool: str,
                                                    subset: dict[str, Any]) -> None:
    first = _stream(client, _CLARIFY_QUESTIONS[kind], persist_conversation=True,
                    idempotency_key=_key("pick", kind, option, "1"))
    assert first["clarify"] and option in first["clarify"]["options"]
    second = _stream(client, option, origin="clarify", persist_conversation=True,
                     conversation_id=first["conversation_id"], idempotency_key=_key("pick", kind, option, "2"))
    steps = _tool_steps(second)
    assert steps and all(s.get("status") == "ok" for s in steps), steps
    assert _matched_step(steps, tool, subset) is not None, (option, [(s["tool"], s.get("params")) for s in steps])
    if option.startswith("Alerts"):
        # Alerts are log events: never answered with a case count.
        assert not {s["tool"] for s in steps} & {"search_cases", "case_stats"}, steps
    assert second["clarify"] is None and second["answer_kind"] == "data" and second["answer"].strip()


def test_the_open_cases_by_month_answer_states_every_month_exactly(client: TestClient) -> None:
    """The screenshot question: each month's figure equals a direct count of the store."""
    truth = _ground_truth(client)
    response = _stream(client, "The amount of total cases right now that are open, when were they all opened ? "
                                "Segregate month wise pls thanks")
    answer = response["answer"]
    assert f"**{truth['active']:,} cases are open right now**" in answer, answer
    for month, n in truth["active_by_month"].items():
        label = f"{_MONTHS[int(month[5:7]) - 1]} {month[:4]}"
        assert re.search(rf"{label}(?: \(in progress\))?: {n:,}\b", answer), (label, n, answer)


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


@pytest.mark.parametrize("question", ["Which hosts generated the most alerts?",
                                      "How many cases do we have by severity?"])
def test_the_step_inspector_follow_ups_explain_and_rerun_that_step(client: TestClient, question: str) -> None:
    """WP-GEN-A: the step inspector's two follow-ups, worded exactly as the console words
    them (``StepInspector.tsx``): "Explain step N" explains that step from the
    conversation (no lookup, never product help); "Run step N again" re-runs exactly
    that lookup with its own inputs, though the question names no window."""
    first = _stream(client, question, persist_conversation=True, idempotency_key=_key("step", question, "1"))
    step = next(s for s in _tool_steps(first) if s["status"] == "ok")
    cid = first["conversation_id"]
    of = f" of your answer to \u201c{question}\u201d"
    explain = _stream(client, f"Explain step {step['index']} ({step['label']}){of}: what it looked up, what it "
                              "found and how it shaped the answer.", origin="follow_up", persist_conversation=True,
                      conversation_id=cid, idempotency_key=_key("step", question, "2"))
    assert not _tool_steps(explain), explain["steps"]
    assert explain["answer_kind"] == "conversation"
    assert explain["answer"].startswith(f"Step {step['index']} ({step['label']}) of my answer to \u201c{question}"
                                        "\u201d read "), explain["answer"]
    assert f"(`{step['tool']}`)" in explain["answer"] and "**What it found:**" in explain["answer"]
    rerun = _stream(client, f"Run step {step['index']} ({step['label']}){of} again with the same inputs and update "
                            "the answer.", origin="retry_step", persist_conversation=True, conversation_id=cid,
                    idempotency_key=_key("step", question, "3"))
    (again,) = _tool_steps(rerun)
    assert again["tool"] == step["tool"] and again["status"] == "ok", again
    assert again["params"] == step["params"], (again["params"], step["params"])
    assert rerun["answer"].startswith(f"Re-ran step {step['index']} ({step['label']}) of my answer to "), rerun["answer"]


def _chip(value: Any) -> str:
    """A step parameter as the lookup digest writes it (``chat_protocol._digest_value``)."""
    return ("true" if value else "false") if isinstance(value, bool) else str(value)


@pytest.mark.parametrize("question", ["Deep dive into user pnair this month",
                                      "Create a report of lifetime performance"])
def test_step_follow_ups_name_the_exact_step_of_a_multi_round_answer(client: TestClient, question: str) -> None:
    """WP-GEN-A review: an answer with several planning rounds numbers a model step
    before every round, and runs the same tool more than once ("Planned lookups" between
    rounds of ``log_stats`` or ``soc_metrics``). "Explain step N" must explain step N's
    own lookup and "Run step N again" must re-run exactly that lookup with all of its
    inputs, for EVERY lookup of the answer, never a sibling with the same label."""
    first = _stream(client, question, persist_conversation=True, idempotency_key=_key("rounds", question, "0"))
    steps = [s for s in _tool_steps(first) if s["status"] == "ok"]
    models = [s for s in first.get("steps") or [] if s.get("kind") != "tool"]
    assert len(models) >= 3, [s.get("label") for s in first.get("steps") or []]  # more than one planning round
    tools = [s["tool"] for s in steps]
    assert len(tools) > len(set(tools)), tools  # some tool ran more than once
    cid = first["conversation_id"]
    of = f" of your answer to \u201c{question}\u201d"
    for n, step in enumerate(steps):
        index, label = step["index"], step["label"]
        explain = _stream(client, f"Explain step {index} ({label}){of}: what it looked up, what it found and how "
                                  "it shaped the answer.", origin="follow_up", persist_conversation=True,
                          conversation_id=cid, idempotency_key=_key("rounds", question, "explain", str(n)))
        body = explain["answer"]
        assert not _tool_steps(explain), (index, explain["steps"])
        assert body.startswith(f"Step {index} ({label}) of my answer to \u201c{question}\u201d read "), (index, body)
        assert f"(`{step['tool']}`)" in body, (index, step["tool"], body)
        looked_up = next(line for line in body.splitlines() if line.startswith("- **What it looked up:**"))
        for name, value in list(step["params"].items())[:8]:
            if value in (None, "") or len(_chip(value)) > 60:
                continue
            assert f"`{name}={_chip(value)}`" in looked_up, (index, name, value, looked_up)
        if step["tool"] in ("lookup_indicator", "recall_observation"):
            continue
        rerun = _stream(client, f"Run step {index} ({label}){of} again with the same inputs and update the answer.",
                        origin="retry_step", persist_conversation=True, conversation_id=cid,
                        idempotency_key=_key("rounds", question, "rerun", str(n)))
        (again,) = _tool_steps(rerun)
        assert again["tool"] == step["tool"] and again["status"] == "ok", (index, again)
        assert again["params"] == step["params"], (index, again["params"], step["params"])
        assert rerun["answer"].startswith(f"Re-ran step {index} ({label}) of my answer to \u201c{question}\u201d "
                                          "with the same inputs:"), (index, rerun["answer"][:300])


def test_a_retried_step_that_fails_again_names_the_step(client: TestClient) -> None:
    """WP-GEN-A final review: "Retry step" on a failed step (its main use) keeps the
    step context when the lookup fails again, instead of a bare failure list."""
    question = "Show me case demo-9999-0000"
    first = _stream(client, question, persist_conversation=True, idempotency_key=_key("fail-again", "1"))
    step = next(s for s in _tool_steps(first) if s["tool"] == "get_case")
    assert step["status"] == "error", step
    rerun = _stream(client, f"Run step {step['index']} ({step['label']}) of your answer to \u201c{question}\u201d "
                            "again with the same inputs and update the answer.", origin="retry_step",
                    persist_conversation=True, conversation_id=first["conversation_id"],
                    idempotency_key=_key("fail-again", "2"))
    (again,) = _tool_steps(rerun)
    assert again["tool"] == "get_case" and again["status"] == "error"
    assert rerun["answer"].startswith(f"Re-ran step {step['index']} (Read a case) of my answer to \u201c{question}"
                                      "\u201d with the same inputs: it failed again (`get_case` error: "), rerun["answer"]
    assert "Lookups that did not complete" not in rerun["answer"]


def test_a_retried_indicator_lookup_the_analyst_typed_runs_again(client: TestClient) -> None:
    """WP-GEN-A final review: the analyst typed the indicator, so the engine's taint
    rule allows the retried lookup (the planner no longer refuses it on its own)."""
    question = "What is the reputation of 8.8.8.8?"
    first = _stream(client, question, persist_conversation=True, idempotency_key=_key("ioc-retry", "1"))
    step = next(s for s in _tool_steps(first) if s["tool"] == "lookup_indicator")
    rerun = _stream(client, f"Run step {step['index']} ({step['label']}) of your answer to \u201c{question}\u201d "
                            "again with the same inputs and update the answer.", origin="retry_step",
                    persist_conversation=True, conversation_id=first["conversation_id"],
                    idempotency_key=_key("ioc-retry", "2"))
    (again,) = _tool_steps(rerun)
    assert again["tool"] == "lookup_indicator" and again["status"] == "ok", again
    assert again["params"] == step["params"]
    assert rerun["answer"].startswith(f"Re-ran step {step['index']} ({step['label']}) of my answer to "), rerun["answer"]
    assert "name the value yourself" not in rerun["answer"]


def test_explain_step_keeps_identifiers_as_stored(client: TestClient) -> None:
    """WP-GEN-A final review: "What it found" shows the stored outcome as written
    (``NEEDS_HUMAN`` keeps its underscore), escaped for Markdown, never stripped."""
    question = "Deep dive into user pnair this month"
    first = _stream(client, question, persist_conversation=True, idempotency_key=_key("as-stored", "1"))
    step = next(s for s in _tool_steps(first) if s["status"] == "ok" and "_" in (s.get("summary") or ""))
    explain = _stream(client, f"Explain step {step['index']} ({step['label']}) of your answer to \u201c{question}"
                              "\u201d: what it looked up, what it found and how it shaped the answer.",
                      origin="follow_up", persist_conversation=True, conversation_id=first["conversation_id"],
                      idempotency_key=_key("as-stored", "2"))
    found = next(line for line in explain["answer"].splitlines() if line.startswith("- **What it found:**"))
    assert re.sub(r"\\(.)", r"\1", found[len("- **What it found:** "):]).rstrip(".") == step["summary"].rstrip("."), found


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
        assert "30 days" not in step["summary"] and not _CAPPED_720.search(step["summary"])


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
