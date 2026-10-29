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
from decimal import ROUND_HALF_UP, Decimal
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
      # The brief is named by the case's display number (every seeded Demo case has one).
      report=True, sections=5, title=r"^Investigation brief: CASE-\d{6}$",
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
      params=(P("case_stats", window="this_month", compare="previous_period"),),
      # The asked figures in the asked order: two stated (T15), MTTR pointed to, and
      # never an unasked one (MTTD) in its place.
      contains=(r"re:(?s)Cases: \*\*.*False-positive rate: \*\*.*MTTR \(median\) is in the figures below",),
      absent=("MTTD",)),
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
    # Round 14 (asks 6 and 7): the operator's two questions, verbatim. Rule rows open the
    # rule sheet, severities are named levels with the rules behind each, never raw numbers.
    G("What are the top detection rules this week?", tools=("log_stats",),
      params=(P("log_stats", group_by="rule", window="this_week"),)),
    G("Show alerts by severity for the last 3 days", tools=("log_stats",),
      params=(P("log_stats", group_by="severity", time_from="now-3d"),),
      contains=("by severity, **",), absent=("`30.0`", "`10.0`")),
    # The operator's open question, verbatim: the detection rules that fired (a table
    # whose rows open each rule) and the events over time, never a case list.
    G("Any suspicious activity in last 3 days ?", tools=("log_stats",), max_lookups=1,
      params=(P("log_stats", group_by="rule", time_from="now-3d"),),
      forbid=(P("search_cases"), P("app_help")), contains=("by rule, ", "not confirmed threats")),
    G("Anything suspicious today?", tools=("log_stats",), max_lookups=1,
      params=(P("log_stats", group_by="rule", window="today"),)),
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
    # An auto-closed false positive: the decision inputs block shows the policy's bars,
    # so the prose names the case's own confidence and risk only (T15, every answer).
    G("Investigate case demo-tune-00000539-0000", tools=("get_case", "explain_decision"),
      params=(P("get_case", case_id="demo-tune-00000539-0000"),),
      contains=("meets the policy's false-positive bar",), absent=("at least 85%", "at most 30")),
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

#: Polish round PB5: an investigation that names an entity investigates THAT entity
#: (a host or user gets the in-depth look, an indicator or a name of no stated kind the
#: hunt), over the window it names; a case is chosen only when the question names one.
#: The re-shoot's misrouted question first, then each entity kind and window phrasing.
_NO_CASE_PICK = (P("search_cases", status="escalated"),)
_HASH = "44d88612fea8a8f36de82e1278abb02f"
ENTITY_INVESTIGATIONS = [
    G("Investigate the activity of user pnair in the last 3 days and the cases it appears in",
      tools=("log_stats", "search_logs", "search_cases", "case_stats"), min_lookups=10,
      may_fail=("lookup_indicator",), notices=("denied", "policy"),
      params=(P("search_logs", user="pnair", time_from="now-3d"), P("search_cases", entity="pnair", window="now-3d")),
      forbid=_NO_CASE_PICK, contains=("In-depth investigation of user `pnair` in the last 3 days",)),
    G("Investigate host dc01 yesterday", tools=("log_stats", "search_logs", "search_cases"), min_lookups=10,
      may_fail=("lookup_indicator",), notices=("denied", "policy"),
      params=(P("search_logs", host="dc01", window="yesterday"),), forbid=_NO_CASE_PICK,
      contains=("In-depth investigation of host `dc01` yesterday",)),
    G("Look into account svc_backup this week", tools=("log_stats", "search_logs", "search_cases"), min_lookups=10,
      may_fail=("lookup_indicator",), notices=("denied", "policy"),
      params=(P("search_logs", user="svc_backup", window="this_week"),), forbid=_NO_CASE_PICK),
    G("What did user pnair do over the last week?", tools=("log_stats", "search_logs", "search_cases"),
      min_lookups=10, may_fail=("lookup_indicator",), notices=("denied", "policy"),
      params=(P("search_logs", user="pnair", time_from="now-7d"),), forbid=_NO_CASE_PICK),
    G("Dig into host appsrv01 this month", tools=("log_stats", "search_logs", "search_cases"), min_lookups=10,
      may_fail=("lookup_indicator",), notices=("denied", "policy"),
      params=(P("search_logs", host="appsrv01", window="this_month"),), forbid=_NO_CASE_PICK),
    G("Investigate user pnair", tools=("log_stats", "search_logs", "search_cases"), min_lookups=10,
      may_fail=("lookup_indicator",), notices=("denied", "policy"),
      params=(P("search_logs", user="pnair", time_from="now-30d"),), forbid=_NO_CASE_PICK),
    G("Investigate the activity of IP 192.0.2.90 in the last 3 days and the cases it appears in",
      tools=("lookup_indicator", "search_logs", "search_cases"),
      params=(P("lookup_indicator", indicator="192.0.2.90", kind="ip"),
              P("search_logs", ip="192.0.2.90", time_from="now-3d"), P("search_cases", entity="192.0.2.90")),
      forbid=_NO_CASE_PICK),
    G("Investigate domain bad.example.com this week", tools=("lookup_indicator", "search_logs", "search_cases"),
      params=(P("lookup_indicator", indicator="bad.example.com", kind="domain"),
              P("search_logs", contains="bad.example.com", window="this_week")), forbid=_NO_CASE_PICK),
    G(f"Investigate file hash {_HASH} over the past 2 weeks", tools=("lookup_indicator", "search_logs", "search_cases"),
      params=(P("lookup_indicator", indicator=_HASH, kind="hash"), P("search_logs", contains=_HASH, window="now-2w")),
      forbid=_NO_CASE_PICK),
    G("Investigate pnair's activity since yesterday", tools=("search_logs", "search_cases"),
      params=(P("search_logs", contains="pnair", window="yesterday..now"), P("search_cases", entity="pnair")),
      forbid=_NO_CASE_PICK),
]

#: Polish round PB6: a word another rule reads is never hunted as a name, an email
#: address is a user, and "Investigate …" picks a case only when it picks one (a named
#: rule, a named source, an attack type and a request for records get their own plans).
INVESTIGATION_ROUTES = [
    G("Investigate T1059.001", tools=("mitre_lookup",), params=(P("mitre_lookup", ids="T1059.001"),),
      forbid=(P("search_logs"),), absent=("No log events match",)),
    G("Investigate T1110", tools=("mitre_lookup",), forbid=(P("search_logs"),)),
    G("What is ingestion doing?", tools=("source_health",), forbid=(P("search_logs"),)),
    G("Investigate costs", tools=("cost_usage",), forbid=(P("search_logs"),)),
    G("What did spend do this week?", tools=("cost_usage",), params=(P("cost_usage", window="this_week"),),
      forbid=(P("search_logs"),)),
    G("What did tuning do?", tools=("automation_status",), params=(P("automation_status", kind="tuning"),),
      forbid=(P("search_logs"),)),
    G("Investigate approvals", tools=("automation_status",), params=(P("automation_status", kind="approvals"),),
      forbid=(P("search_logs"),)),
    G("What has autopilot been doing?", kind="product_help", tools=("app_help",), max_lookups=1),
    G("What did enrichment do?", kind="product_help", tools=("app_help",), max_lookups=1),
    G("What is risk doing?", kind="product_help", tools=("app_help",), max_lookups=1),
    G("Show activity by severity", tools=("log_stats",), params=(P("log_stats", group_by="severity"),),
      forbid=(P("search_logs", contains="severity"),)),
    # A plain name is still searched for (its log events and the cases that carry it).
    G("What did alice do today?", tools=("search_logs", "search_cases"),
      params=(P("search_logs", contains="alice", window="today"),), forbid=_NO_CASE_PICK),
    G("Look into the activity of admin@corp.example", tools=("log_stats", "search_logs", "search_cases"),
      min_lookups=10, may_fail=("lookup_indicator",), notices=("denied", "policy"),
      params=(P("search_logs", user="admin@corp.example"),),
      forbid=(*_NO_CASE_PICK, P("search_logs", contains="re:^admin@corp$|^corp\\.example$"))),
    G("Investigate email jdoe@corp.example", tools=("log_stats", "search_logs", "search_cases"), min_lookups=10,
      may_fail=("lookup_indicator",), notices=("denied", "policy"),
      params=(P("search_logs", user="jdoe@corp.example"),),
      forbid=(*_NO_CASE_PICK, P("lookup_indicator", indicator="corp.example"),
              P("search_logs", contains="corp.example"))),
    # The HITL pair's Splunk case carries Splunk's impossible-travel rule (Round 14
    # FX3b2: a seeded case carries the rule its Demo source raises), opened this week.
    G("Investigate rule LP-ES-RISK-1004 this week", tools=("case_stats",),
      params=(P("case_stats", rule="LP-ES-RISK-1004", group_by="verdict", window="this_week"),),
      forbid=_NO_CASE_PICK, contains=("from rule `LP-ES-RISK-1004` this week",)),
    G("Investigate source Wazuh", tools=("source_health", "search_logs"),
      params=(P("search_logs", source_id="demo-wazuh"),), forbid=_NO_CASE_PICK,
      contains=("Recent events from `Wazuh Manager (endpoint telemetry)`",)),
    G("Investigate source wazuh-prod", tools=("source_health",), forbid=_NO_CASE_PICK,
      contains=("No log source named `wazuh-prod` is configured", "Configured sources: ")),
    G("Investigate ransomware", tools=("search_cases",), params=(P("search_cases", text="ransom"),),
      forbid=_NO_CASE_PICK),
    G("Investigate the false positives from yesterday", tools=("search_cases",),
      params=(P("search_cases", verdict="FALSE_POSITIVE", window="yesterday"),), forbid=_NO_CASE_PICK),
    G("Investigate today's alerts", tools=("search_cases",), params=(P("search_cases", window="today"),),
      forbid=_NO_CASE_PICK),
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
      report=True, sections=5, title=r"^Investigation brief: CASE-\d{6}$",
      params=(P("search_cases", status="escalated"),)),
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
      contains=(r"re:\A\*\*Critical cases, .+ compared with .+\*\*\. Changes are computed exactly:",
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
    # In the first moments of a month no case has closed yet, and the answer says so
    # (plain, not bold: "No closed case matched in April 2027. …").
    G("What share of cases did the AI close this month?", tools=("case_stats",),
      params=(P("case_stats", status_group="terminal", window="this_month", metrics="re:auto_closed"),),
      forbid=(P("search_cases"),),
      contains=(r"re:\A(?:\*\*\d+(?:\.\d)?%\*\* of the closed cases|No closed case matched in )",)),
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
      # A8: the case's display number leads (every seeded Demo case has one), then what
      # it is about.
      # The seeded case carries the rule its Demo source raises, and Entra ID names the
      # person by the user principal name its sign-in records carry (Round 14 FX3b2).
      contains=("re:^\\*\\*`CASE-\\d{6}`\\*\\* \\(`Entra ID Protection: atypical travel sign-in` on user "
                "`dsingh@lumenpay\\.example`\\)",),
      absent=("I can't write",)),
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
                   *CASES, *DEEP, *ENTITY_INVESTIGATIONS, *INVESTIGATION_ROUTES, *APP_HELP, *PLATFORM, *CLARIFY, *READ_ONLY, *REGRESSIONS, *REGRESSIONS_R2,
                   *EXPLAIN_RECORDS, *OUT_OF_SCOPE, *CLOSING]


def test_the_golden_set_is_big_enough_and_has_every_screenshot_question() -> None:
    questions = [g.q for g in GOLDEN]
    assert len(questions) >= 120 and len(set(questions)) == len(questions)
    for verbatim in ("Create a report of lifetime performance pls thanks",
                     "Last 90 days or whatever reports you can",
                     "What are the top detection rules this week?",
                     "Show alerts by severity for the last 3 days",
                     "Any suspicious activity in last 3 days ?",
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


# Round 13 T15 (the takeaway rule): an answer with a ``kpi_group`` of three or more
# figures names at most two of them in its prose. A figure counts as named when the
# prose writes its value (as the planner formats that unit) in a clause that also
# names it (a word of its label), so a coincidence ("Low: 32" beside an Auto-closed
# tile of 32) is not counted.
_T15_STOP = frozenset({"the", "and", "for", "with", "now", "still", "per", "rate", "median"})


def _t15_quantize(value: float, places: int = 0) -> Decimal:
    return Decimal(str(value)).quantize(Decimal(1).scaleb(-places), rounding=ROUND_HALF_UP)


def _t15_dec(value: float) -> str:
    text = f"{_t15_quantize(value, 1)}"
    return text[:-2] if text.endswith(".0") else text


def _t15_forms(item: dict[str, Any]) -> set[str]:
    value = item.get("value")
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return set()
    unit = item.get("unit") or "count"
    if unit == "percent":
        return {f"{_t15_dec(value)}%", f"{_t15_quantize(value)}%"}
    if unit == "ratio":
        return {f"{_t15_dec(value * 100)}%", f"{_t15_quantize(value * 100)}%"}
    if unit == "usd":
        return {f"${value:,.2f}", f"${value:,.4f}"}
    if unit == "minutes":
        return {f"{_t15_dec(value)} min", f"{_t15_dec(value / 60)} h", f"{_t15_dec(value)} minutes"}
    if unit in ("seconds", "ms", "hours"):
        return {f"{_t15_dec(value)} {u}" for u in ("s", "ms", "h", "seconds", "hours")}
    if unit == "score":
        # The prose writes a score as the console does, "7/100" (Round 13 close).
        whole = int(_t15_quantize(value))
        return {_t15_dec(value), f"{whole:,}", str(whole)}
    if value == int(value) or item.get("display") == "gauge":
        whole = int(_t15_quantize(value))
        return {f"{whole:,}", str(whole)}
    return {_t15_dec(value)}


def _t15_keywords(item: dict[str, Any]) -> set[str]:
    label = re.sub(r"\([^)]*\)", " ", str(item.get("label") or "")).lower()
    words = [w for w in re.split(r"[^a-z]+", label) if len(w) >= 3 and w not in _T15_STOP]
    return {w[:4] for w in words} or {label.strip()[:4]}


def _t15_named(clause: str, form: str) -> bool:
    lead = r"(?<![\w.,$])" if form[0].isdigit() else r"(?<![\w.,])"
    return re.search(lead + re.escape(form) + r"(?![\w%]|[.,]\d)", clause) is not None


def _t15_groups(blocks: Any) -> Iterator[dict[str, Any]]:
    for block in blocks or []:
        if not isinstance(block, dict):
            continue
        if block.get("type") == "kpi_group":
            yield block
        elif block.get("type") == "report":
            for section in block.get("sections") or []:
                yield from _t15_groups((section.get("blocks") or []) + (section.get("items") or []))


_BARE_ID_LEAD = re.compile(r"^(?:- |\d+\. )?(?:\*\*)?`(?:case-[0-9a-f]{32}|demo-[A-Za-z0-9-]+)`(?:\*\*)?(?! \()")


def _bare_id_leads(answer: str) -> list[str]:
    """Prose lines that lead with an internal case id and no title (A8)."""
    return [line for line in (answer or "").splitlines() if _BARE_ID_LEAD.match(line.strip())]


def test_the_bare_id_check_itself() -> None:
    assert _bare_id_leads("**`demo-00000539-0004`** (identity signin on user `dsingh`) is open.")
    assert _bare_id_leads("- `case-062c11bc99b64c92853d96a798730094`, `case-3f6c7a7091e643edaddc9728b7d6e873`")
    assert not _bare_id_leads("**identity signin on user `dsingh`** (`demo-00000539-0004`) is open.")
    assert not _bare_id_leads("- `CASE-000042` · identity signin on user `dsingh` (high, risk 80, open)")
    # A rule id leads as inline code since Round 13 polish PB3; it is not a case id.
    assert not _bare_id_leads("**`identity_signin` on user `dsingh`** (`demo-00000539-0004`) is open.")
    assert not _bare_id_leads("- `demo_impossible_travel` on user `pnair` (`demo-hitl-0`) (high, risk 62)")


def test_the_takeaway_check_reads_label_and_value_as_one_clause() -> None:
    """The T15 checker itself: "Label: **value**" names that figure (never split at the
    colon), and clock times and dates are labels, not figures."""
    group = [{"type": "kpi_group", "title": "Posture", "items": [
        {"label": "Cases", "value": 7, "unit": "count"},
        {"label": "False-positive rate", "value": 42.9, "unit": "percent"},
        {"label": "Automation rate", "value": 50, "unit": "percent"}]}]
    named_three = "- Cases: **7** in W41.\n- False-positive rate: **42.9%** in W41.\nAutomation rate: no change (50%)."
    assert _t15_violations(named_three, group)
    assert not _t15_violations("- Cases: **7** in W41.\n- False-positive rate: **42.9%** in W41.", group)
    assert not _t15_violations("Cases per hour: 17 Oct 19:00: 0 and 17 Oct 22:00: 7. FP rate **42.9%**.", group)
    # A word two labels share ("positive") never names the other figure: the
    # false-positive rate's baseline that happens to equal the true-positive rate is the
    # false-positive rate's figure, and the true-positive rate stays unnamed.
    rates = [{"type": "kpi_group", "title": "Change", "items": [
        {"label": "Cases", "value": 7, "unit": "count"},
        {"label": "False-positive rate", "value": 28.57, "unit": "percent"},
        {"label": "True-positive rate", "value": 42.86, "unit": "percent"}]}]
    assert not _t15_violations("- Cases: **7** in W43 vs 7 in W42.\n"
                               "- False-positive rate: **29%** in W43 vs 43% in W42.", rates)
    assert _t15_violations("- Cases: **7** in W43.\n- False-positive rate: **29%** in W43.\n"
                           "- True-positive rate: **43%** in W43.", rates)


def _t15_violations(answer: str, blocks: Any) -> list[tuple[Any, list[Any]]]:
    text = re.sub(r"`[^`]*`", " ", answer or "")  # inline code: ids and entity values, never a figure
    # Clock times and dates are bucket labels ("17 Oct 19:00", "W41 2026"), never a figure.
    text = re.sub(r"\b\d{1,2}:\d{2}\b|\b\d{1,2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b|\bW\d{1,2}\b|"
                  r"\b(?:19|20)\d{2}\b", " ", text)
    # A clause runs to a full stop, a semicolon or a line end. Never split at a colon:
    # "False-positive rate: **42.9%**" names the figure in ONE clause (label and value).
    clauses = [c.lower() for c in re.split(r"(?<=[.;])\s+|\n+", text) if c.strip()]
    bad = []
    for group in _t15_groups(blocks):
        items = [i for i in group.get("items") or [] if isinstance(i, dict)]
        if len(items) < 3:
            continue
        named: dict[frozenset[str], list[Any]] = {}
        all_keys = [_t15_keywords(item) for item in items]
        for at, item in enumerate(items):
            forms, keys = _t15_forms(item), all_keys[at]
            # The words that tell this figure from the group's others: "positive" names
            # both rates, so only "false" or "true" says which one a clause states (the
            # false-positive rate's baseline of 43% is not the true-positive rate's 43%).
            others = set().union(*(k for i, k in enumerate(all_keys) if i != at))
            keys = (keys - others) or keys
            if any(_t15_named(c, f) and any(k in c for k in keys) for c in clauses for f in forms):
                named.setdefault(frozenset(forms), []).append(item.get("label"))
        if len(named) > 2:
            bad.append((group.get("title"), list(named.values())))
    return bad


# Round 13 close (one figure, one form): the console writes a percent whole from 10%
# up, with one decimal under 10% and "<1%" for a sliver, rounded half up, and a 0 to 100
# score (an average risk) as "N/100". The prose and a report's own text state each figure
# the same way, so "77.5%" never sits under a "78%" tile. A signed change ("+12.5%",
# "+3.5 points") keeps the comparison's own form. Inline code (log values, rule names)
# is not prose.
_LONG_PERCENT = re.compile(r"(?<![\d.,+−-])(?:[1-9]\d+\.\d+|0\.\d+)%")
_DECIMAL_SCORE = re.compile(r"\baverage risk \**(\d+(?:\.\d+)?)(?!\d|\.\d|/100)")


def _report_texts(blocks: Any) -> Iterator[str]:
    """The text a report envelope writes itself: section summaries and markdown items."""
    for block in blocks or []:
        if not isinstance(block, dict):
            continue
        if block.get("type") == "markdown" and isinstance(block.get("text"), str):
            yield block["text"]
        elif block.get("type") == "report":
            for section in block.get("sections") or []:
                if isinstance(section.get("summary"), str):
                    yield section["summary"]
                yield from _report_texts((section.get("blocks") or []) + (section.get("items") or []))


def _figure_form_violations(response: dict[str, Any]) -> list[str]:
    # The run log's step summaries too (Round 13 close BF): a live model reads them, so
    # "FP rate 75.6%" there under a "76%" tile is the same figure stated two ways.
    texts = [response.get("answer") or "", *_report_texts(response.get("blocks")),
             *(s.get("summary") or "" for s in _tool_steps(response))]
    bad: list[str] = []
    for text in texts:
        prose = re.sub(r"`[^`]*`", " ", text)
        bad += _LONG_PERCENT.findall(prose)
        bad += [f"average risk {m}" for m in _DECIMAL_SCORE.findall(prose)]
    return bad


# Round 13 close (BF): a case's ATT&CK techniques in the prose ("ATT&CK: …" in a case
# brief, "The source case maps to ATT&CK …" in a hunt) are every technique its ATT&CK
# block lists, or the first ones and "and K more techniques"; never a silent cut.
_TECHNIQUE_SENTENCE = re.compile(r"(?:^|\n|\. )(?:ATT&CK: |The source case maps to ATT&CK )([^\n]*?\.)(?=\s|$)")
_TECHNIQUE_ID = re.compile(r"\bT\d{4}(?:\.\d{3})?\b")
_MORE_TECHNIQUES = re.compile(r" and (\d+) more techniques\.$")


def _technique_violations(response: dict[str, Any]) -> list[str]:
    blocks = [b for b in _report_blocks(response.get("blocks")) if b.get("type") == "mitre"]
    if len(blocks) != 1:
        return []
    listed = [str(t.get("id")) for t in blocks[0].get("techniques") or [] if isinstance(t, dict)]
    bad: list[str] = []
    for text in [response.get("answer") or "", *_report_texts(response.get("blocks"))]:
        for sentence in _TECHNIQUE_SENTENCE.findall(text):
            named = _TECHNIQUE_ID.findall(sentence)
            more = _MORE_TECHNIQUES.search(sentence)
            if not set(named) <= set(listed) or len(named) + (int(more.group(1)) if more else 0) != len(listed):
                bad.append(f"{sentence} (block: {', '.join(listed)})")
    return bad


def test_the_technique_check_itself() -> None:
    block = {"type": "mitre", "techniques": [{"id": t} for t in ("T1566", "T1078", "T1021", "T1048")]}
    def check(answer: str) -> list[str]:
        return _technique_violations({"answer": answer, "blocks": [block]})
    assert not check("The source case maps to ATT&CK T1566 Phishing, T1078 Valid Accounts, T1021 Remote "
                     "Services and T1048 Exfiltration.")
    assert check("The source case maps to ATT&CK T1566 Phishing, T1078 Valid Accounts and T1021 Remote Services.")
    assert not check("ATT&CK: T1566 Phishing (initial-access), T1078 Valid Accounts and 2 more techniques.")
    assert check("ATT&CK: T1566 Phishing and 2 more techniques.")


def test_the_figure_form_check_itself() -> None:
    def check(text: str) -> list[str]:
        return _figure_form_violations({"answer": text})
    assert check("The false-positive rate is 77.5%.") == ["77.5%"]
    assert check("FP rate **78%**, automation 7.5%, change +12.5%, −35.6%; <1% left; 0.4% of them") == ["0.4%"]
    assert check("average risk 7.4 and average risk 27/100") == ["average risk 7.4"]
    assert check("average risk **7** in the window") == ["average risk 7"]
    assert not check("rule `t1-77.5%-rule` and 100% done")
    step = {"kind": "tool", "tool": "soc_metrics", "summary": "Posture, last 24 hours: 45 cases, FP rate 75.6%"}
    assert _figure_form_violations({"answer": "", "steps": [step]}) == ["75.6%"]


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
    # Round 13 A8: no prose line leads with a bare internal case id; a case with no
    # number leads with what it is about, its id after it.
    assert not _bare_id_leads(answer), (_bare_id_leads(answer), context)
    # Round 13 T15: beside a key-figure block of three or more figures, the prose gives
    # the takeaway and names at most two of them.
    assert not _t15_violations(answer, response.get("blocks")), (_t15_violations(answer, response.get("blocks")),
                                                                  context)
    # Round 13 close: every figure in the form the console's tiles show it (one figure,
    # one form), in the prose and in the report text beside the blocks.
    assert not _figure_form_violations(response), (_figure_form_violations(response), context)
    # Round 13 close (BF): the prose names a case's techniques as its ATT&CK block lists them.
    assert not _technique_violations(response), (_technique_violations(response), context)
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
            expected = _figure_text(fig.text, n)
            assert expected in answer or (n == 0 and fig.zero in answer), (expected, n, context)


_FIGURE_NOUN = re.compile(r"^((?: [a-z]+)*) cases\b")


def test_a_figure_of_one_case_reads_in_the_singular() -> None:
    assert _figure_text("**{n} cases**", 1) == "**1 case**"
    assert _figure_text("**{n} cases**", 0) == "**0 cases**"
    assert _figure_text("**{n} cases**", 1_204) == "**1,204 cases**"
    assert _figure_text("**{n} cases are open right now**", 1) == "**1 case is open right now**"
    assert _figure_text("**{n} open cases** were opened more than 7 days ago", 1) == (
        "**1 open case** was opened more than 7 days ago")
    assert _figure_text("of {n} closed cases", 1) == "of 1 closed case"
    assert _figure_text("were false positives: {n} of", 1) == "were false positives: 1 of"


def _figure_text(text: str, n: int) -> str:
    """``text`` with ``{n}`` filled in, as the answer states it: a count of one takes
    the singular noun and verb after it ("**1 case**", "**1 case is open right now**",
    "**1 open case** was opened ..."), as the planner's ``_plural`` does, so a figure
    check never depends on the day's store holding more than one matching case. Only
    the words after the count change ("were false positives: 1 of 5" keeps its verb)."""
    head, sep, tail = text.partition("{n}")
    if sep and n == 1:
        tail = _FIGURE_NOUN.sub(r"\1 case", tail).replace(" are ", " is ").replace(" were ", " was ")
    return (head + sep + tail).format(n=f"{n:,}")


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
    """Cases created in ``window`` (half-open, like the aggregator) matching ``filters``.
    A relative window of days, weeks, months or years counts whole periods, the last in
    progress, exactly as every chat case lookup counts it ("last 7 days (since 12 Oct)",
    ``chat_tools.common.whole_periods``); otherwise the count would depend on the time
    of day the suite runs."""
    from app.constants import OPEN_CASE_STATUSES, TERMINAL_CASE_STATUSES
    from app.engine.priority import band_of_case
    from app.engine.time_windows import align_whole_periods, resolve_window

    resolved = None if window in (None, "all") else align_whole_periods(resolve_window(window, tz="UTC"))
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


def test_the_operator_rule_and_severity_answers_open_their_detail(client: TestClient) -> None:
    """Round 14 (SPEC §4.6.3, §4.7, acceptance A6b): the operator's two questions
    reproduce with clickable rows. Every rule bar (and its table row) opens the rule
    sheet of exactly that rule over the answer's window; the severity answer is a table of
    the five named levels in fixed order, each level opening the Logs page filtered to it
    and each rule in it the rule sheet; nothing is labelled with a raw source number."""
    rules = _stream(client, "What are the top detection rules this week?")
    chart = next(b for b in rules["blocks"] if b.get("artifact_kind") == "categories")
    labels = chart["x"]["values"] if chart["type"] == "chart" else [r[0] for r in chart["rows"]]
    drill = chart["drill"]
    assert len(drill) == len(labels) and labels
    for label, ref in zip(labels, drill):
        assert ref["page"] == "rule" and ref["opts"]["rule"] == label
        assert {"from", "to"} <= set(ref["opts"])
    assert "table" in chart["allowed_views"]

    severity = _stream(client, "Show alerts by severity for the last 3 days")
    table = next(b for b in severity["blocks"] if b.get("artifact_kind") == "categories")
    assert table["type"] == "table" and table["columns"][0]["label"] == "Severity"
    names = [row[0].split(" (")[0] for row in table["rows"]]
    assert names == ["Critical", "High", "Medium", "Low", "Info"]
    payload = table["severity"]
    assert [lv["level"] for lv in payload["levels"]] == ["critical", "high", "medium", "low", "info"]
    shares = [lv["share"] for lv in payload["levels"] if lv["count"]]
    assert abs(sum(shares) - 100.0) <= 0.1 * len(shares)
    for level, ref in zip(payload["levels"], table["drill"]):
        assert ref["page"] == "logs" and ref["opts"]["severity"] == level["level"]
        for rule in level["rules"]:
            assert rule["drill"]["page"] == "rule" and rule["drill"]["opts"]["rule"] == rule["key"]
    assert "30.0" not in json.dumps(table["rows"])
    # The Demo sources count exactly (every event fits the newest 200): no sample stated.
    assert payload["sample"]["exact"] is True and "sampled" not in (table.get("caption") or "")

    # "Any suspicious activity in last 3 days ?": the rules as a table whose every row
    # opens that rule's sheet over the answer's window, then the events over time.
    suspicious = _stream(client, "Any suspicious activity in last 3 days ?")
    kinds = [(b.get("artifact_kind"), b["type"]) for b in suspicious["blocks"]]
    assert kinds == [("categories", "table"), ("series", "chart")], kinds
    rules_table, series = suspicious["blocks"]
    assert rules_table["title"] == "Top detection rules (last 3 days)" and series["title"] == "Events over time"
    rows = [row[0] for row in rules_table["rows"]]
    assert rows and len(rules_table["drill"]) == len(rows)
    for label, ref in zip(rows, rules_table["drill"]):
        assert ref["page"] == "rule" and ref["opts"]["rule"] == label
        assert {"from", "to"} <= set(ref["opts"])


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


# --------------------------------------------------------------------------- #
# Round 13 (SPEC-chat §3.15, §4.3; WP-DEMO13): every console starter through the
# stream in Demo, the case chips in a case chat, follow-up chips answered for what
# they name, the takeaway rule (T15) and the conversation title (T6).
# --------------------------------------------------------------------------- #
from app.agents import chat_starter_text as starter_text  # noqa: E402
from app.agents.chat_protocol import parse_title  # noqa: E402
from app.api.routes_chat_starters import router as starters_router  # noqa: E402
from app.engine import demo_chat  # noqa: E402

#: The templates answered as product help (SPEC §3.15): the rest are data answers.
_PRODUCT_STARTERS = frozenset({"learn_app", "explain_metric", "connect_source", "demo"})
_PRODUCT_KINDS = ("product_help", "mixed")
#: Every fenced span of a prompt (the engine's untrusted fences).
_FENCED = re.compile(r"<<<UNTRUSTED_[A-Z_]+>>>.*?<<<END_UNTRUSTED_[A-Z_]+>>>", re.DOTALL)
_COUNTED = "The suggestion counted"


@pytest.fixture(scope="module")
def starter_client() -> Iterator[TestClient]:
    """Its own Demo app (with the starters route): these tests close a case, so they
    never share the golden set's store."""
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
    for router in (base_router, chat_router, library_router, reports_router, starters_router):
        api.include_router(router)
    try:
        with TestClient(api) as test_client:
            yield test_client
    finally:
        patch.undo()


class _PlannerPrompts:
    """Every prompt the Demo planner received (the messages ``plan_turn`` was given)."""

    def __init__(self) -> None:
        self.rounds: list[list[dict[str, Any]]] = []

    def unfenced(self) -> str:
        """The analyst- and engine-written text of every round, fences removed (the
        planner's own earlier tool calls are its actions, not its instructions)."""
        return "\n".join(_FENCED.sub(" ", str(m.get("content") or "")) for rnd in self.rounds for m in rnd
                         if m.get("role") in ("user", "system"))

    def fenced_refs(self) -> list[dict[str, Any]]:
        refs = []
        for rnd in self.rounds:
            for m in rnd:
                for body in re.findall(r"<<<UNTRUSTED_[A-Z_]+>>> source=entity_ref\n(.*?)\n<<<END_UNTRUSTED",
                                       str(m.get("content") or ""), re.DOTALL):
                    refs.append(json.loads(body))
        return refs


@pytest.fixture()
def planner_prompts(monkeypatch: pytest.MonkeyPatch) -> _PlannerPrompts:
    seen = _PlannerPrompts()
    real = demo_chat.plan_turn

    def spy(messages: Any) -> str:
        seen.rounds.append([dict(m) for m in messages])
        return real(messages)

    monkeypatch.setattr(demo_chat, "plan_turn", spy)
    return seen


def _status(case: Any) -> str:
    return str(getattr(case.status, "value", case.status))


def _verdict(case: Any) -> str:
    return str(getattr(case.verdict, "value", case.verdict))


def _created(case: Any) -> datetime:
    created = datetime.fromisoformat(str(case.created_at))
    return created if created.tzinfo else created.replace(tzinfo=UTC)


def _home_cards(client: TestClient) -> list[dict[str, Any]]:
    response = client.get("/api/chat/starters", params={"surface": "home"})
    assert response.status_code == 200, response.text
    return [c for c in response.json()["starters"] if c.get("action") == "send"]


def _starter_slots(client: TestClient) -> dict[str, dict[str, Any]]:
    """Slots for every send template, read from the Demo store itself: a count slot
    holds the store's own figure wherever the store has one (so an answer that says
    "the suggestion counted …" means the planner's figure disagrees with the store)."""
    from app.engine.chat_starters import hunt_window

    cases = _store_cases(client)
    now = datetime.now(UTC)
    active = [c for c in cases if _status(c) in ACTIVE_STATUSES]
    needs = next(c for c in active if _verdict(c) == "NEEDS_HUMAN")
    assigned = next(c for c in active if getattr(c, "assignee", ""))
    day = [c for c in cases if _created(c) >= now - timedelta(hours=24)]
    rules: dict[str, int] = {}
    for case in day:
        for rule in dict.fromkeys(case.rule_ids or []):
            rules[rule] = rules.get(rule, 0) + 1
    rule, rule_n = max(rules.items(), key=lambda kv: (kv[1], kv[0]))
    window = hunt_window("UTC", now)
    techniques: dict[str, int] = {}
    for case in cases:
        if window.start <= _created(case) < (window.end or now + timedelta(days=1)):
            for tid in dict.fromkeys(case.mitre or []):
                techniques[tid] = techniques.get(tid, 0) + 1
    technique, technique_n = max(techniques.items(), key=lambda kv: (kv[1], kv[0]))
    assert technique_n >= 2 and rule_n >= 1 and len(day) >= 2, (technique_n, rule_n, len(day))
    campaigns, _total = client.portal.call(  # type: ignore[union-attr]
        lambda: _state(client).campaign_store.list(status="open", limit=5))
    # Not the most recently active campaign when Demo has several (polish PB4): the
    # answer must be about the campaign its case names, not whichever is newest.
    campaign = campaigns[-1]
    by_id = {c.case_id: c for c in cases}
    member = max((by_id[cid] for cid in campaign.case_ids if cid in by_id), key=lambda c: (_created(c), c.case_id))
    yesterday = starter_text.format_since(now - timedelta(hours=26), now=now, tz=UTC)
    last_month = (now.replace(day=1) - timedelta(days=1))
    close = int(_sla_totals(client).get("about_to_breach") or 0)
    return {
        # A card names a case by its display number (``chat_starters._Build.case_value``).
        "needs_human": {"case": _handle(needs)},
        # This app has sign-in off, so "me" names no one and the answer says so (see the
        # test); any count works.
        "my_cases": {"n": 2}, "my_cases_one": {"case": _handle(assigned)},
        "sla_breached_one": {"case": _handle(needs)}, "sla_close": {"n": max(2, close)},
        "sla_close_one": {"case": _handle(assigned)},
        "new_cases_one": {"since": yesterday},
        "volume_drop": {"n": max(2, len(day) // 4), "m": len(day)},
        "noisy_rule": {"rule": rule, "n": rule_n, "m": len(day)},
        "noisy_rule_unnamed": {"n": rule_n, "m": len(day)},
        # The card names the campaign by one of its cases, never by its id (Round 13
        # polish PB3, PB4).
        "campaign": {"n": max(2, len(campaign.case_ids)), "case": _handle(member)},
        "silent_source": {"source": "demo-wazuh"}, "silent_sources": {"n": 2}, "silent_source_unnamed": {},
        "budget_ai": {"pct": 85}, "budget_chat": {"pct": 90},
        "shift_start": {"h": 24}, "shift_handoff": {}, "weekly": {},
        "monthly": {"month": starter_text.format_month(last_month.year, last_month.month)},
        "hunt": {"technique": technique, "n": technique_n},
        "approvals": {"n": 2}, "approvals_one": {}, "platform": {}, "demo": {}, "triage": {}, "posture": {},
        "report": {}, "explain_metric": {}, "learn_app": {}, "connect_source": {},
    }


def _report_section_text(response: dict[str, Any], heading: str) -> str:
    """The Markdown text of a report envelope's section named ``heading``."""
    for block in response.get("blocks") or []:
        for section in (block.get("sections") or []) if isinstance(block, dict) else []:
            if section.get("heading") == heading:
                return "\n".join(str(i.get("text") or "") for i in section.get("blocks") or section.get("items") or []
                                 if isinstance(i, dict) and i.get("type") == "markdown")
    return ""


def _handle(case: Any) -> str:
    """How a card names a case: its display number, else its id."""
    return getattr(case, "case_number", "") or case.case_id


def _sla_totals(client: TestClient) -> dict[str, Any]:
    """The shift snapshot's SLA totals (breached, about to breach), read directly."""
    state = _state(client)
    snap = client.portal.call(lambda: state.standup_service.shift_snapshot(state.prefs, window_hours=24))
    return (snap.get("sla_aging") or {}).get("totals") or {}


def client_campaigns(client: TestClient) -> list[Any]:
    campaigns, _total = client.portal.call(lambda: _state(client).campaign_store.list(status="open", limit=50))
    return list(campaigns)


def _usual_daily(cases: list[Any], now: datetime) -> int:
    """The volume card's usual daily level, counted from the store the way
    ``chat_starters.volume_windows`` counts it: the median of the seven 24-hour windows
    that end at the start of the hour holding "24 hours ago"."""
    edge = (now - timedelta(hours=24)).replace(minute=0, second=0, microsecond=0)
    windows = sorted(sum(1 for c in cases if edge - timedelta(hours=24 * i) <= _created(c)
                         < edge - timedelta(hours=24 * (i - 1))) for i in range(7, 0, -1))
    return windows[3]


def _ref_values(template_id: str, slots: dict[str, Any]) -> list[str]:
    """The referenced values a template's slots hold (a case, rule, source, campaign or
    technique): the values that must reach the planner only inside their fence."""
    return [str(slots[name]) for name in ("case", "rule", "source", "campaign", "technique") if slots.get(name)]


def _check_starter(template_id: str, response: dict[str, Any], prompts: _PlannerPrompts,
                   slots: dict[str, Any]) -> None:
    answer = response.get("answer") or ""
    context = (template_id, answer[:500], [(s["tool"], s.get("status"), s.get("params"))
                                           for s in _tool_steps(response)])
    assert answer.strip() and "could not plan an answer" not in answer and "could not map" not in answer, context
    notice = (response.get("notice") or {}).get("kind")
    assert notice not in ("unsupported", "unsupported_no_link"), (notice, context)
    kind = response.get("answer_kind")
    if template_id in _PRODUCT_STARTERS:
        assert kind in _PRODUCT_KINDS, (kind, context)
    else:
        assert kind == "data", (kind, context)
        ok = {s["tool"] for s in _tool_steps(response) if s.get("status") == "ok"}
        assert ok - {"app_help", "app_status"}, context
    # The referenced value reached the planner only inside its entity_ref fence.
    unfenced = prompts.unfenced()
    for value in _ref_values(template_id, slots):
        assert value not in unfenced, (value, template_id)
        assert any(ref.get("value") == value for ref in prompts.fenced_refs()), (value, template_id)
    assert not _bare_id_leads(answer), (_bare_id_leads(answer), context)
    # A follow-up names a case only when this answer shows it (its words or its
    # blocks), never a case a lookup merely observed (Round 13 polish PB3).
    shown = answer + json.dumps(response.get("blocks") or [])
    for chip in response.get("follow_ups") or []:
        for ref in re.findall(r"\bCASE-\d+\b", chip):
            assert ref in shown, (chip, context)
    # The takeaway rule (T15): a key-figure block of three or more figures, and the
    # prose names at most two of them.
    assert not _t15_violations(answer, response.get("blocks")), (_t15_violations(answer, response.get("blocks")),
                                                                  context)


_SEND_TEMPLATES = [tid for tid, spec in starter_text.TEMPLATES.items()
                   if spec.action == "send" and not tid.startswith("case_")]


def test_every_send_template_is_covered() -> None:
    """Every home and thread send template is sent below (from the live cards or from
    store-read slots); the case chips have their own test."""
    covered = {"needs_human", "sla_breached", "new_cases", "volume_spike", "my_cases", "my_cases_one",
               "sla_breached_one", "sla_close", "sla_close_one", "new_cases_one", "volume_drop", "noisy_rule",
               "campaign", "silent_source", "silent_sources", "budget_ai", "budget_chat", "shift_start",
               "shift_handoff", "weekly", "monthly", "hunt", "approvals", "approvals_one", "platform", "demo",
               "triage", "posture", "report", "explain_metric", "learn_app", "connect_source",
               # Polish round PB5: the wordings without a reference the length rule uses.
               "noisy_rule_unnamed", "silent_source_unnamed"}
    assert set(_SEND_TEMPLATES) == covered, set(_SEND_TEMPLATES) ^ covered


def test_the_demo_home_cards_answer_with_the_figures_they_state(starter_client: TestClient,
                                                                  planner_prompts: _PlannerPrompts) -> None:
    """The live Demo home cards (the starter engine's own counts, read from the store)
    sent as the console sends them: each answer states the card's figure and never
    says the figure moved."""
    cards = _home_cards(starter_client)
    assert len(cards) >= 4, [c.get("template") for c in cards]
    for card in cards:
        parsed = starter_text.parse_starter_question(card["prompt"])
        assert parsed is not None, card
        template_id, slots = parsed
        planner_prompts.rounds.clear()
        response = _stream(starter_client, card["prompt"], origin="starter")
        _check_starter(template_id, response, planner_prompts, dict(slots))
        answer = response["answer"]
        assert _COUNTED not in answer, (template_id, answer[:400])
        if isinstance(slots.get("n"), int):
            assert f"**{slots['n']:,} " in answer, (template_id, slots, answer[:400])


def test_the_home_card_counts_match_the_case_store(starter_client: TestClient) -> None:
    """The figures the cards (and so their answers) state equal a direct count of the
    case store: new cases since the card's time, and new cases in the last 24 hours."""
    from zoneinfo import ZoneInfo

    now = datetime.now(UTC)
    cases = _store_cases(starter_client)
    zone = ZoneInfo(starter_client.get("/api/chat/starters", params={"surface": "home"}).json()["timezone"])
    for card in _home_cards(starter_client):
        parsed = starter_text.parse_starter_question(card["prompt"])
        assert parsed is not None
        template_id, slots = parsed
        if template_id == "volume_spike":
            day = [c for c in cases if _created(c) >= now - timedelta(hours=24)]
            assert slots["n"] == len(day), (slots, len(day))
        if template_id == "new_cases":
            since = _label_instant(str(slots["since"]), now, zone)
            assert slots["n"] == sum(1 for c in cases if _created(c) >= since), (slots, since)


_WEEKDAY_WORDS = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")
_MONTH_WORDS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")


def _label_instant(label: str, now: datetime, zone: Any) -> datetime:
    """The instant a ``{since}`` label names, read from the label alone (SPEC §3.7):
    "09:12" today, "yesterday 18:40", "Mon 18:40" within 7 days at that minute, "12 Oct"
    at local midnight."""
    local = now.astimezone(zone)
    words = label.split()
    if len(words) == 2 and words[1] in _MONTH_WORDS:
        day = local.replace(month=_MONTH_WORDS.index(words[1]) + 1, day=int(words[0]),
                            hour=0, minute=0, second=0, microsecond=0)
        if day > local:
            day = day.replace(year=day.year - 1)
        return day.astimezone(UTC)
    hour, minute = (int(p) for p in words[-1].split(":"))
    back = (0 if len(words) == 1 else 1 if words[0] == "yesterday"
            else (local.weekday() - _WEEKDAY_WORDS.index(words[0])) % 7)
    at = (local - timedelta(days=back)).replace(hour=hour, minute=minute, second=0, microsecond=0)
    return at.astimezone(UTC)


def _pick_last_visit(created: list[datetime], now: datetime, zone: Any, shape: str) -> tuple[datetime, datetime]:
    """A last-visit time whose ``{since}`` label names an earlier instant than the visit
    itself, with a store case in between, and that instant: a date-only label (9 or
    more days back, at 14:00 local, with a case that morning), or a clock label (a
    baseline one second after a case created mid-minute)."""
    if shape == "date":
        for back in range(9, 30):
            day = (now.astimezone(zone) - timedelta(days=back)).replace(hour=0, minute=0, second=0, microsecond=0)
            last = day + timedelta(hours=14)
            if any(day <= t < last for t in created) and any(t >= last for t in created):
                return last.astimezone(UTC), day.astimezone(UTC)
        raise AssertionError("no Demo day has a case before 14:00")
    pick = next(t for t in reversed(created)
                if now - timedelta(days=5) < t < now - timedelta(minutes=40) and 1 <= t.second <= 50)
    last = pick + timedelta(seconds=1)
    return last, last.replace(second=0, microsecond=0)


@pytest.mark.parametrize("shape", ["date", "minute"])
def test_a_new_cases_card_counts_from_the_instant_its_label_names(starter_client: TestClient, shape: str) -> None:
    """The new-cases card and its catch-up clause count from the instant the "since"
    label names (local midnight of a date-only label, the minute of a clock label), the
    instant an answer to that question counts from: the answer states the card's
    figure and never says it moved (SPEC-chat §3.3, §3.7, §3.8.7)."""
    from zoneinfo import ZoneInfo

    from app.engine.chat_starters import StarterUserState

    state = _state(starter_client)
    created = sorted(_created(c) for c in _store_cases(starter_client))
    info = starter_client.get("/api/chat/starters", params={"surface": "home"}).json()
    zone = ZoneInfo(info["timezone"])
    now = datetime.now(UTC)
    last, start = _pick_last_visit(created, now, zone, shape)
    assert sum(1 for t in created if t >= start) > sum(1 for t in created if t >= last)

    def visited(_previous: Any) -> Any:
        return StarterUserState(last_seen_at=last, visit_started_at=last - timedelta(minutes=10),
                                catchup_since=last - timedelta(days=1), shift_started_at=last - timedelta(hours=1))

    starter_client.portal.call(lambda: state.chat_starters.update("", visited))  # type: ignore[union-attr]
    try:
        info = starter_client.get("/api/chat/starters", params={"surface": "home"}).json()
        card = next(c for c in info["starters"] if c.get("template") == "new_cases")
        parsed = starter_text.parse_starter_question(card["prompt"])
        assert parsed is not None
        _template, slots = parsed
        expected = sum(1 for t in created if t >= start)
        assert slots["n"] == expected, (card["prompt"], expected)
        catch_up = info["catch_up"]
        assert catch_up is not None and catch_up["since_label"] == slots["since"]
        assert datetime.fromisoformat(catch_up["since"].replace("Z", "+00:00")) == start
        assert catch_up["clauses"][0]["text"].startswith(f"{expected:,} new cases")
        response = _stream(starter_client, card["prompt"], origin="starter")
        answer = response["answer"]
        assert _COUNTED not in answer, answer[:400]
        assert f"**{expected:,} " in answer, answer[:400]
    finally:
        starter_client.portal.call(lambda: state.chat_starters.clear(""))  # type: ignore[union-attr]


@pytest.mark.parametrize("template_id", [t for t in _SEND_TEMPLATES
                                         if t not in ("sla_breached", "new_cases", "volume_spike")])
def test_every_starter_template_answers_from_demo_data(starter_client: TestClient, planner_prompts: _PlannerPrompts,
                                                        template_id: str) -> None:
    slots = _starter_slots(starter_client)[template_id]
    question = starter_text.render_question(template_id, slots)
    planner_prompts.rounds.clear()
    response = _stream(starter_client, question, origin="starter")
    _check_starter(template_id, response, planner_prompts, slots)
    answer = response["answer"]
    # The template's own lookups ran (the card's ``tools``, as far as Demo grants them).
    spec = starter_text.TEMPLATES[template_id]
    ok = {s["tool"] for s in _tool_steps(response) if s.get("status") == "ok"}
    if template_id not in _PRODUCT_STARTERS:
        assert ok & set(spec.tools), (template_id, spec.tools, ok)
    # Figures from the store: the slots above hold the store's own count, so the
    # answer states it and never says it moved.
    cases = _store_cases(starter_client)
    now = datetime.now(UTC)
    # One display form per rule (Round 13 polish PB3): a rule id is never also spelled
    # as words ("demo impossible travel") beside the id the blocks show.
    for rule in {r for c in cases for r in (c.rule_ids or []) if "_" in r}:
        assert rule.replace("_", " ") not in answer, (rule, answer[:300])
    if template_id == "my_cases":
        # Sign-in is off here, so assignee "me" names no one: the answer says so and
        # shows the whole open queue by assignee, never as the analyst's own cases.
        open_total = sum(1 for c in cases if _status(c) in ACTIVE_STATUSES)
        assert answer.startswith("No analyst is signed in (sign-in is off), so chat cannot tell which open "
                                 "cases are yours."), answer[:300]
        assert f"The open queue (**{open_total:,} cases**) by assignee" in answer, answer[:300]
    if template_id in ("needs_human", "my_cases_one", "sla_breached_one", "sla_close_one"):
        # The answer is about the referenced case.
        assert f"`{slots['case']}`" in answer, answer[:300]
    if template_id == "sla_close":
        close = int(_sla_totals(starter_client).get("about_to_breach") or 0)
        if close == slots["n"]:
            assert _COUNTED not in answer, answer[:300]
        else:
            assert (f"The suggestion counted {slots['n']:,} cases; there {'is' if close == 1 else 'are'} "
                    f"{close:,} now.") in answer, answer[:300]
    if template_id == "new_cases_one":
        label = str(slots["since"])
        # "yesterday 22:11", or "Fri 22:11" in the two hours after midnight (26 hours back
        # is then two days back): the day the label names, at its clock time.
        words = label.split()
        hour, minute = (int(p) for p in words[-1].split(":"))
        back = (0 if len(words) == 1 else 1 if words[0] == "yesterday"
                else (now.weekday() - ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun").index(words[0])) % 7)
        start = (now - timedelta(days=back)).replace(hour=hour, minute=minute, second=0, microsecond=0)
        opened = sum(1 for c in cases if _created(c) >= start)
        assert f"**{opened:,} case" in answer and f"since {label}" in answer, (opened, answer[:300])
    if template_id == "volume_drop":
        day = sum(1 for c in cases if _created(c) >= now - timedelta(hours=24))
        before = sum(1 for c in cases if now - timedelta(hours=48) <= _created(c) < now - timedelta(hours=24))
        assert answer.startswith(f"**{day:,} new case"), answer[:300]
        assert f"against {before:,} in the 24 hours before" in answer, answer[:300]
        assert f"The usual daily level is {_usual_daily(cases, now):,}" in answer, answer[:300]
    if template_id == "campaign":
        # The campaign that holds the named case, whichever campaign is newest.
        member = next(c for c in cases if _handle(c) == slots["case"])
        campaign = next(c for c in client_campaigns(starter_client) if member.case_id in c.case_ids)
        assert answer.startswith(f"The campaign that includes `{slots['case']}` links "
                                 f"**{len(campaign.case_ids):,} cases**"), answer[:300]
        assert campaign.id not in answer and _COUNTED not in answer, answer[:300]
    if template_id == "hunt":
        # The slot holds the store's count of the technique's cases in the hunt window.
        assert f"**{slots['n']:,} cases**" in answer and _COUNTED not in answer, answer[:400]
    if template_id == "noisy_rule":
        assert f"`{slots['rule']}`" in answer and _COUNTED not in answer, answer[:400]
    if template_id == "noisy_rule_unnamed":
        # The card counted the rule without naming it (PB5): the answer finds it by that
        # count and names every rule that created that many cases in the last 24 hours.
        day = [c for c in cases if _created(c) >= now - timedelta(hours=24)]
        counts: dict[str, int] = {}
        for case in day:
            for rule_id in dict.fromkeys(case.rule_ids or []):
                counts[rule_id] = counts.get(rule_id, 0) + 1
        named = sorted(r for r, n in counts.items() if n == slots["n"])
        assert named and all(f"`{r}`" in answer for r in named), (named, answer[:400])
        assert _COUNTED not in answer and "No rule has exactly" not in answer, answer[:400]
        assert ("each created" in answer) == (len(named) > 1), answer[:400]
    if template_id == "silent_source_unnamed":
        assert "No log source is quiet now" in answer, answer[:300]
    if template_id == "silent_sources":
        # The store has no quiet source: the answer says so, and that the card's count moved.
        assert "No log source is quiet now" in answer and _COUNTED in answer, answer[:300]
    if template_id in ("shift_start", "shift_handoff"):
        # Round 13 polish PB3: the total past SLA is the store's, stated the same in the
        # lead and the steps, and the step lists exactly the cases it says it names.
        breached = int(_sla_totals(starter_client).get("breached") or 0)
        steps = _report_section_text(response, "Next steps")
        step = re.search(r"Work the ([\d,]+) cases? past SLA first(?:, starting with the (?:(\d+) )?most "
                         r"overdue)?(?:: (.*?))?\.(?:\n|$)", steps)
        if breached:
            assert f"{breached:,} of them past SLA" in answer, answer[:300]
            assert step is not None and int(step.group(1).replace(",", "")) == breached, steps
            listed = re.findall(r"CASE-\d+", step.group(3) or "")
            said = (int(step.group(2)) if step.group(2) else 1 if "starting with the most overdue" in step.group(0)
                    else breached)
            assert len(listed) == said, steps
        else:
            assert step is None, steps
        # Polish round PB4: one starting point. When the step names the cases past SLA,
        # the lead starts with its first one; otherwise only one of them says "start".
        lead = re.search(r"Start with `(CASE-\d+)`", answer)
        first = re.findall(r"CASE-\d+", (step.group(3) or "") if step else "")
        if lead and first:
            assert lead.group(1) == first[0], (answer[:400], steps)
        assert not (lead and step and not first and "starting with" in step.group(0)), (answer[:400], steps)
    if template_id == "approvals":
        pending = next(s for s in _tool_steps(response) if s["tool"] == "automation_status")
        stated = re.match(r"\*\*(\d+) changes?\*\*", answer)
        assert stated and stated.group(1) in pending["summary"], (answer[:200], pending["summary"])


def test_a_case_closed_after_its_card_was_made_is_answered_as_closed(starter_client: TestClient) -> None:
    """SPEC §3.15: a case closed between the card and the send yields an answer that
    says it was closed (and no longer needs a person)."""
    from app.constants import CaseStatus

    case = next(c for c in _store_cases(starter_client)
                if _status(c) in ACTIVE_STATUSES and _verdict(c) == "NEEDS_HUMAN")
    question = starter_text.render_question("needs_human", {"case": _handle(case)})
    store = _state(starter_client).cases
    starter_client.portal.call(  # type: ignore[union-attr]
        lambda: store.save(case.model_copy(update={"status": CaseStatus.CLOSED})))
    response = _stream(starter_client, question, origin="starter")
    answer = response["answer"]
    assert response["answer_kind"] == "data"
    assert f"`{_handle(case)}`" in answer and "was closed after this suggestion was made" in answer, answer[:400]
    assert "no longer needs a person" in answer, answer[:400]


#: The analyst the signed-in Demo app logs in as, and how many open cases it owns there.
_ME, _MY_OPEN = "Admin", 3
#: Ages (minutes) of the open cases the signed-in Demo app adds close to their response
#: target: a case with no priority has a 120-minute target, and "close" is the last
#: quarter of it (Round 13 polish).
_NEAR_AGES = (91, 95, 98, 101, 104, 107, 110)


def _near_target_cases(numbered: list[Any]) -> list[Any]:
    """Seven fresh open cases close to their response target, numbered after the Demo's
    own (every other one assigned), so the SLA answers have near-target rows to name."""
    from app.constants import CaseStatus, EntityType, SourceSurface, Verdict
    from app.models import Case, Entity

    last = max((int(m.group(1)) for c in numbered
                if (m := re.fullmatch(r"CASE-(\d+)", str(getattr(c, "case_number", "") or "")))), default=0)
    now = datetime.now(UTC)
    out = []
    for i, minutes in enumerate(_NEAR_AGES):
        created = (now - timedelta(minutes=minutes)).isoformat()
        out.append(Case(
            case_id=f"golden-near-{i}", cluster_signature=f"golden-near-{i}",
            source_surface=SourceSurface.INVESTIGATE, entity=Entity(type=EntityType.HOST, value=f"ws-near-{i}"),
            status=CaseStatus.OPEN, verdict=Verdict.NEEDS_HUMAN, risk_score=20.0, created_at=created,
            updated_at=created, assignee="dsingh" if i % 2 else "", case_number=f"CASE-{last + 1 + i:06d}",
            rule_ids=["demo_near_target"], title=f"host:ws-near-{i} \u00b7 demo_near_target",
        ))
    return out


@pytest.fixture(scope="module")
def signed_in_client() -> Iterator[TestClient]:
    """A Demo app with sign-in on and Admin signed in, owning the 3 highest-risk open
    cases, with seven open cases close to their response target (Round 13 polish): the
    "my cases" cards count the caller's own open cases and their answers list only
    those (assignee "me", resolved by the server); the SLA answers name the near rows."""
    from fastapi import Depends

    from app.api.deps import require_auth

    patch = pytest.MonkeyPatch()
    patch.setattr(providers, "DEMO_STREAM_DELAY_S", 0)
    secrets = Secrets(_env_file=None, es_store_enabled=False, redis_url="", anthropic_api_key=None,
                      openai_api_key=None, auth_enabled=True, auth_jwt_secret="golden-signed-in-secret",
                      auth_seed_admin=True)
    overrides = {"anthropic": MockProvider(), "openai": MockProvider(), "mock": MockProvider()}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        state = AppState.create(secrets=secrets, es=InMemoryESClient(), provider_overrides=overrides)
        await state.startup(start_poller=False)
        await state.update_prefs(state.prefs.model_copy(update={
            "setup_complete": True, "rbac": state.prefs.rbac.model_copy(update={"enabled": True})}))
        await state.enable_demo(mode="seeded", seed=1337, history_days=30)
        rows, _cursor, _snapshot, _consistency = await state.cases.export_page(limit=500, cursor=None)
        active = sorted((c for c in rows if _status(c) in ACTIVE_STATUSES),
                        key=lambda c: (-(c.risk_score or 0), c.case_id))
        for case in active[:_MY_OPEN]:
            await state.cases.save(case.model_copy(update={"assignee": _ME}))
        for case in _near_target_cases(rows):
            await state.cases.save(case)
        app.state.tlsoc = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    for router in (base_router, chat_router, library_router, reports_router, starters_router):
        api.include_router(router, dependencies=[Depends(require_auth)])
    try:
        with TestClient(api) as test_client:
            response = test_client.post("/api/auth/login", json={"username": _ME, "password": "Admin@123"})
            assert response.status_code == 200, response.text
            yield test_client
    finally:
        patch.undo()


def _my_open_cases(client: TestClient) -> list[Any]:
    """The caller's own open cases, highest risk first (a direct store read)."""
    mine = [c for c in _store_cases(client) if _status(c) in ACTIVE_STATUSES
            and str(getattr(c, "assignee", "") or "").strip().lower() == _ME.lower()]
    return sorted(mine, key=lambda c: (-(c.risk_score or 0), c.case_id))


def test_the_my_cases_card_and_its_answer_count_only_the_callers_cases(signed_in_client: TestClient) -> None:
    """Round 13 polish: the "my cases" card counts the signed-in analyst's own open
    cases, and its answer (assignee "me") states that count and lists only those cases,
    never the whole open queue and never "the suggestion counted"."""
    mine = _my_open_cases(signed_in_client)
    assert len(mine) == _MY_OPEN
    starters = signed_in_client.get("/api/chat/starters", params={"surface": "home"}).json()["starters"]
    card = next((c for c in starters if c.get("template") == "my_cases"), None)
    assert card is not None, [c.get("template") for c in starters]
    parsed = starter_text.parse_starter_question(card["prompt"])
    assert parsed is not None and parsed[0] == "my_cases"
    assert parsed[1]["n"] == len(mine), (card["prompt"], len(mine))
    response = _stream(signed_in_client, card["prompt"], origin="starter")
    answer = response["answer"]
    (step,) = [s for s in _tool_steps(response) if s["tool"] == "search_cases"]
    assert step["status"] == "ok" and (step.get("params") or {}).get("assignee") == "me", step
    assert answer.startswith(f"**{len(mine)} open cases** are assigned to you."), answer[:300]
    assert _COUNTED not in answer and "No analyst is signed in" not in answer, answer[:300]
    (listed,) = [b for b in response["blocks"] if b.get("type") == "case_list"]
    numbers = [i.get("case_number") for i in listed.get("items") or []]
    assert numbers == [c.case_number for c in mine], (numbers, [c.case_number for c in mine])
    assert f"Start with **`{mine[0].case_number}`**" in answer, answer[:300]
    # Each rule one way across the answer (Round 13 polish PB3): its id, as the list shows it.
    for rule in {r for c in mine for r in (c.rule_ids or [])}:
        assert f"`{rule}`" in answer and rule.replace("_", " ") not in answer.replace(f"`{rule}`", ""), \
            (rule, answer[:600])


def test_the_my_case_answer_lists_only_the_callers_other_cases(signed_in_client: TestClient) -> None:
    """Round 13 polish: "What should I do next on case X?" reads the caller's own open
    cases beside it and lists the others, by number, highest risk first."""
    mine = _my_open_cases(signed_in_client)
    question = starter_text.render_question("my_cases_one", {"case": mine[0].case_number})
    response = _stream(signed_in_client, question, origin="starter")
    answer = response["answer"]
    assert any(s["tool"] == "search_cases" and (s.get("params") or {}).get("assignee") == "me"
               and s.get("status") == "ok" for s in _tool_steps(response)), _tool_steps(response)
    assert f"It is one of your **{len(mine)} open cases**; the others, highest risk first:" in answer, answer[:600]
    listed = re.findall(r"^- `(CASE-\d+)`", answer, re.MULTILINE)
    assert listed == [c.case_number for c in mine[1:]], (listed, answer[:600])


#: "My cases" questions that name more than the analyst's open cases (Round 13 polish
#: review): each is classified as usual, and every case lookup it sends carries
#: assignee "me" beside the filters the question names.
_MY_VARIANTS = [
    ("Which of my cases were closed as false positive?", "search_cases",
     {"status_group": "terminal", "verdict": "FALSE_POSITIVE"}),
    ("How many of my cases are critical?", "search_cases", {"severity": "critical"}),
    ("Break down my open cases by severity", "case_stats", {"status_group": "active", "group_by": "severity"}),
    ("Are any of my cases escalated?", "search_cases", {"status": "escalated"}),
    ("List cases assigned to me that are high severity", "search_cases", {"severity": "high"}),
    ("Show my open cases from this week", "search_cases", {"status_group": "active", "window": "this_week"}),
    ("List my critical cases", "search_cases", {"severity": "critical"}),
    ("Show my closed cases", "search_cases", {"status_group": "terminal"}),
    ("What changed on my cases since yesterday?", "search_cases", {}),
    ("Compare my cases this week vs last week", "case_stats", {"compare": "previous_period", "window": "this_week"}),
]


@pytest.mark.parametrize("question, tool, params", _MY_VARIANTS)
def test_a_my_cases_question_keeps_its_filters_and_asks_for_me(signed_in_client: TestClient, question: str,
                                                              tool: str, params: dict[str, Any]) -> None:
    response = _stream(signed_in_client, question)
    steps = [s for s in _tool_steps(response) if s["tool"] in ("search_cases", "case_stats")]
    assert steps and all((s.get("params") or {}).get("assignee") == "me" for s in steps), steps
    assert any(s["tool"] == tool and s.get("status") == "ok"
               and all((s.get("params") or {}).get(k) == v for k, v in params.items()) for s in steps), steps
    answer = response["answer"]
    assert "No analyst is signed in" not in answer and _COUNTED not in answer, answer[:300]
    assert "assigned to you" in answer, answer[:400]
    # Every case the answer lists is the caller's own.
    mine = {c.case_number for c in _store_cases(signed_in_client)
            if str(getattr(c, "assignee", "") or "").strip().lower() == _ME.lower()}
    listed = [i.get("case_number") for b in response.get("blocks") or [] if b.get("type") == "case_list"
              for i in b.get("items") or []]
    assert set(listed) <= mine, (listed, mine)
    assert response["conversation_title"] is None or not response["conversation_title"].startswith("Case list")


@pytest.mark.parametrize("question, note", [
    ("Give me the shift handoff for my cases", "cannot be narrowed to the cases assigned to you"),
    ("How is the security posture of my cases?", "cannot be narrowed to the cases assigned to you"),
])
def test_a_my_cases_question_a_snapshot_cannot_filter_says_so(signed_in_client: TestClient, question: str,
                                                              note: str) -> None:
    response = _stream(signed_in_client, question)
    assert note in response["answer"], response["answer"][:600]
    assert not [s for s in _tool_steps(response) if s["tool"] == "search_cases"
                and (s.get("params") or {}).get("assignee") == "me"], _tool_steps(response)


def _near_rows(client: TestClient) -> tuple[int, list[Any]]:
    """``(close total, the near cases nearest first)`` read directly: the shift
    snapshot's close-to-target total and the store's own near cases this app added,
    ordered by the time left (the oldest first, all sharing one target)."""
    total = int(_sla_totals(client).get("about_to_breach") or 0)
    near = [c for c in _store_cases(client) if str(c.case_id).startswith("golden-near-")]
    return total, sorted(near, key=lambda c: _created(c))


def test_the_sla_close_answer_names_the_nearest_cases_and_who_has_them(signed_in_client: TestClient) -> None:
    """Round 13 polish: "Which N cases are close to their response target, and who has
    them?" states the snapshot's count and lists the nearest cases the lookup returns,
    nearest first, each with its number, owner and the time left."""
    total, near = _near_rows(signed_in_client)
    assert total == len(near) == len(_NEAR_AGES), (total, len(near))
    question = starter_text.render_question("sla_close", {"n": total})
    response = _stream(signed_in_client, question, origin="starter")
    answer = response["answer"]
    assert answer.startswith(f"**{total} cases** are close to their response target"), answer[:300]
    assert _COUNTED not in answer and "without naming" not in answer, answer[:300]
    rows = re.findall(r"^- `(CASE-\d+)`.*?, (assigned to `[^`]+`|not assigned), (\d+) min left$", answer, re.MULTILINE)
    expected = [(c.case_number, f"assigned to `{c.assignee}`" if c.assignee else "not assigned") for c in near[:5]]
    assert [(number, owner) for number, owner, _left in rows] == expected, (rows, answer[:900])
    lefts = [int(left) for _n, _o, left in rows]
    assert lefts == sorted(lefts) and all(0 < left <= 30 for left in lefts), lefts
    assert f"The shift snapshot names the 5 nearest; the other {total - 5} are counted above." in answer


def test_the_sla_close_one_answer_says_who_has_it_and_the_time_left(signed_in_client: TestClient) -> None:
    """Round 13 polish: "Who has case X, and will it meet its response target?" for a
    case close to its target names its owner and the time left."""
    _total, near = _near_rows(signed_in_client)
    case = next(c for c in near if c.assignee)
    question = starter_text.render_question("sla_close_one", {"case": case.case_number})
    response = _stream(signed_in_client, question, origin="starter")
    answer = response["answer"]
    assert answer.startswith(f"**`{case.case_number}`**") and f"assigned to `{case.assignee}`" in answer, answer[:300]
    assert re.search(r"It is close to its response target, with \d+ min left\.", answer), answer[:400]


@pytest.mark.parametrize("template_id, pick, tool", [
    ("case_needs_person", "needs_human", "explain_decision"),
    ("case_undecided", "open", "get_case"),
    ("case_closed_why", "closed", "explain_decision"),
    ("case_entity", "needs_human", "search_cases"),
    ("case_related", "needs_human", "search_cases"),
    ("case_handoff", "open", "get_case"),
])
def test_every_case_chip_is_answered_for_its_case(starter_client: TestClient, template_id: str, pick: str,
                                                  tool: str) -> None:
    """SPEC §3.14/§3.15: each case chip, sent in a Demo case chat, is answered for that
    case: a data answer about it, by its handle, through the chip's lookups."""
    cases = _store_cases(starter_client)
    case = next(c for c in cases if (
        (pick == "needs_human" and _status(c) in ACTIVE_STATUSES and _verdict(c) == "NEEDS_HUMAN")
        or (pick == "open" and _status(c) in ACTIVE_STATUSES)
        or (pick == "closed" and _status(c) == "closed")))
    question = starter_text.render_question(template_id, {})
    response = _stream(starter_client, question, origin="starter", case_id=case.case_id)
    answer = response["answer"]
    ok = [s for s in _tool_steps(response) if s.get("status") == "ok"]
    assert response["answer_kind"] == "data", (template_id, answer[:300])
    assert (response.get("notice") or {}).get("kind") not in ("unsupported", "unsupported_no_link")
    assert any(s["tool"] == "get_case" for s in ok) and any(s["tool"] == tool for s in ok), (template_id, ok)
    # About THIS case: by its handle, or as "this case" (the chat is the case's own).
    handle = getattr(case, "case_number", None) or case.case_id
    assert f"`{handle}`" in answer or "this case" in answer.lower(), (template_id, answer[:300])
    assert all((s.get("params") or {}).get("case_id") in (None, case.case_id) for s in ok if s["tool"] == "get_case")
    assert response.get("case_id") == case.case_id
    # Its chips name this case only, never another one a lookup listed (F14).
    others = {c.case_id for c in cases if c.case_id != case.case_id}
    assert not [chip for chip in response.get("follow_ups") or [] if any(o in chip for o in others)], \
        response.get("follow_ups")


def test_case_chat_follow_up_chips_are_answered_for_the_case(starter_client: TestClient) -> None:
    """Every chip under a Case Manager chat answer, sent back in that case chat (whose
    history replays no lookup digest), is answered for the chat's own case; "Which
    other cases share an entity with …" lists the cases on its entity."""
    case = next(c for c in _store_cases(starter_client)
                if _status(c) in ACTIVE_STATUSES and _verdict(c) == "NEEDS_HUMAN" and c.entity)
    question = starter_text.render_question("case_needs_person", {})
    first = _stream(starter_client, question, origin="starter", case_id=case.case_id)
    chips = first.get("follow_ups") or []
    assert chips, first.get("answer", "")[:300]
    history = [{"role": "user", "content": question, "origin": "starter"},
               {"role": "assistant", "content": first["answer"]}]
    for chip in chips:
        response = _stream(starter_client, chip, origin="follow_up", case_id=case.case_id, history=history)
        answer = response["answer"]
        ok = [s for s in _tool_steps(response) if s.get("status") == "ok"]
        assert response["answer_kind"] in ("data", "mixed"), (chip, answer[:300])
        # A chip names the case by its display number, which reads the same case.
        assert all((s.get("params") or {}).get("case_id") in (None, case.case_id, case.case_number)
                   for s in ok if s["tool"] == "get_case"), (chip, ok)
        if chip.lower().startswith("which other cases share"):
            assert any(s["tool"] == "search_cases" and (s.get("params") or {}).get("entity") for s in ok), (chip, ok)
            assert "share" in answer or "No other case" in answer, (chip, answer[:300])


#: The planner's own follow-up chips and the tools each one names (``demo_chat._CHIPS``)
#: plus the engine's deterministic chips (``agents.chat_followups``): a chip, sent back,
#: is answered by the lookups it names, never by help, a clarify card or the fallback.
_ENGINE_CHIPS: tuple[tuple[str, tuple[str, ...] | None], ...] = (
    (r"Investigate the top .+ in this answer", ("search_logs",)),
    (r"Which of these cases are still open, and who has them\?", ("search_cases",)),
    (r"Explain T[\d.]+ and whether other cases show it", ("mitre_lookup",)),
    (r"What else did this .+ do in the .+\?", ("search_logs",)),
    (r"Compare this with the previous .+", None),
    (r"Show the same .+", None),
    (r"Break this down by .+ instead", None),
    # The breakdown answer's own chip: the same cases and window over time.
    (r"Show these cases .*by (?:hour|day|week|month)", ("case_stats",)),
)

#: What a chip's next turn must look up, beyond the tool: the filter, grouping or
#: window its words define (F1: a chip is answered for what it names, never by an
#: unfiltered list). ``(chip pattern, tool, {param: expected value or "re:…"})``.
_CHIP_FILTERS: tuple[tuple[str, str, dict[str, Any]], ...] = (
    (r"Which cases were escalated\b", "search_cases", {"status": "escalated"}),
    (r"Who closed the cases\b", "case_stats", {"group_by": "closed_by"}),
    (r"Which open cases need human review\?", "search_cases", {"status_group": "active", "verdict": "NEEDS_HUMAN"}),
    (r"How many cases came from .+\?", "case_stats", {"group_by": "source"}),
    (r"Which cases drove the false-positive rate\b", "search_cases", {"verdict": "FALSE_POSITIVE"}),
    (r"List the true positives\b", "search_cases", {"verdict": "TRUE_POSITIVE"}),
    (r"List the false positives\b", "search_cases", {"verdict": "FALSE_POSITIVE"}),
    (r"Which rules drove the false positives\b", "case_stats", {"group_by": "rule", "verdict": "FALSE_POSITIVE"}),
    (r"Which open cases push the Active Risk Index up\?", "search_cases", {"status_group": "active"}),
    (r"Show the failed sign-ins by user\b", "log_stats", {"group_by": "user"}),
    (r"Which of these cases are still open\b", "search_cases", {"status_group": "active"}),
    (r"Show the cases .+ by severity", "case_stats", {"group_by": "severity"}),
    (r"Show these cases .*by day", "case_stats", {"bucket": "day"}),
    (r"Show these cases .*by hour", "case_stats", {"bucket": "hour"}),
    (r"Show these cases .*by week", "case_stats", {"bucket": "week"}),
    (r"Show these cases .*by month", "case_stats", {"bucket": "month"}),
    (r"Which of the cases since \d+ \w+ \d{4} \d{2}:\d{2} are critical\?", "search_cases",
     {"severity": "critical", "window": r"re:T\d{2}:\d{2}"}),
    (r"Show the cases since \d+ \w+ \d{4} \d{2}:\d{2} by rule", "case_stats",
     {"group_by": "rule", "window": r"re:T\d{2}:\d{2}"}),
    (r"Show the case status changes\b", "audit_search", {"action_type": "status"}),
    (r"Which model spent the most\b", "cost_usage", {"group_by": "model"}),
    (r"Show the AI spend by role\b", "cost_usage", {"group_by": "role"}),
    (r"Which other cases share an entity with \S+\?", "search_cases", {"entity": "re:."}),
)


def _assert_chip_filters(chip: str, second: dict[str, Any]) -> None:
    steps = _tool_steps(second)
    for pattern, tool, subset in _CHIP_FILTERS:
        if re.fullmatch(pattern + r".*", chip):
            assert _matched_step(steps, tool, subset) is not None, (chip, tool, subset,
                                                                    [(s["tool"], s.get("params")) for s in steps])
    match = re.fullmatch(r"(?:Investigate|Summarise) (\S+)(?: for a handoff note)?", chip)
    if match:
        assert _matched_step(steps, "get_case", {"case_id": match.group(1)}) is not None, (chip, steps)


def _chip_tools(chip: str) -> tuple[str, tuple[str, ...] | None] | None:
    for rows in demo_chat._CHIPS.values():
        for text, tools in rows:
            if re.fullmatch(re.sub(r"\\\{[a-z_]+\\\}", ".+", re.escape(text)), chip, re.IGNORECASE):
                return text, tools
    for pattern, tools in _ENGINE_CHIPS:
        if re.fullmatch(pattern, chip):
            return pattern, tools
    return None


_FOLLOWED = [
    "How is our security posture right now?", "Which hosts had the most events in the last 24 hours?",
    "List the cases from the last 7 days", "Show me the newest escalated case", "What did the AI spend this week?",
    "Cases by severity in the last 7 days", "Which ATT&CK techniques show up in our cases?",
    "What do we know about 198.51.100.7?", "Compare this month vs last month: cases, FP rate, MTTR",
    "Show me the MTTR trend over the last 30 days", "Are any log sources silent?",
    "Give me an investigation brief for case demo-00000539-0052", "Show the case trend from 2026-08-01 to 2026-09-30",
    "How many open critical false positives this week?",
    # Round 13 review (F1, F17): chips whose words define a filter the answer must use.
    "Show me the noise reduction funnel", "Show the audit trail for today", "List the escalated cases",
    "Show brute force attempts in the last 24 hours", "Are all log sources healthy?",
]


@pytest.mark.parametrize("question", _FOLLOWED)
def test_every_follow_up_chip_is_answered_for_what_it_names(starter_client: TestClient, question: str) -> None:
    """SPEC §4.1/§4.3, T4: each chip under a Demo answer, sent as the console sends it
    (origin follow_up, in the conversation whose latest answer it sits under), runs
    the lookups it names; a chip about "this answer" re-reads that answer's lookups."""
    first = _stream(starter_client, question, persist_conversation=True, idempotency_key=_key("chip", question))
    chips = list(first["follow_ups"])
    assert chips, (question, first["answer"][:200])
    for n, chip in enumerate(chips):
        # Each chip under the answer it was offered with (a fresh copy of the turn).
        under = first if n == 0 else _stream(starter_client, question, persist_conversation=True,
                                              idempotency_key=_key("chip", question, str(n)))
        data = {s["tool"] for s in _tool_steps(under) if s.get("status") == "ok"} - {"app_help", "app_status"}
        second = _stream(starter_client, chip, origin="follow_up", persist_conversation=True,
                         conversation_id=under["conversation_id"], idempotency_key=_key("chip", question, chip))
        _assert_chip_answered(question, chip, data, second)


def _assert_chip_answered(question: str, chip: str, data: set[str], second: dict[str, Any]) -> None:
    answer = second["answer"]
    ok = [s["tool"] for s in _tool_steps(second) if s.get("status") == "ok"]
    context = (question, chip, ok, answer[:300])
    assert "could not map" not in answer and "could not plan" not in answer, context
    assert second.get("clarify") is None, context
    assert set(ok) - {"app_help", "app_status"}, context
    named = _chip_tools(chip)
    assert named is not None, ("a chip no table names", context)
    _assert_chip_filters(chip, second)
    if named[1]:
        assert set(named[1]) & set(ok), (named[1], context)
    elif data:
        # "Compare this…", "Show the same…", "Break this down…": the earlier answer's
        # own lookups again (a case list compares through the case counts).
        assert data & set(ok) or ("search_cases" in data and "case_stats" in ok), (data, context)


@pytest.mark.parametrize("template_id", ["sla_breached", "hunt", "campaign", "noisy_rule", "approvals", "platform",
                                         "volume_drop", "new_cases_one", "silent_source", "my_cases"])
def test_starter_answers_offer_chips_about_what_they_show(starter_client: TestClient, template_id: str) -> None:
    """T4: a starter answer's chips name what it shows (its window, a case, a
    technique, its figures) and each one is answered."""
    slots = _starter_slots(starter_client).get(template_id)
    if slots is None:
        card = next(c for c in _home_cards(starter_client) if c["template"] == template_id)
        question = card["prompt"]
    else:
        question = starter_text.render_question(template_id, slots)
    first = _stream(starter_client, question, origin="starter", persist_conversation=True,
                    idempotency_key=_key("starter-chips", template_id))
    chips = list(first["follow_ups"])
    assert chips, (template_id, first["answer"][:300])
    for n, chip in enumerate(chips):
        under = first if n == 0 else _stream(starter_client, question, origin="starter", persist_conversation=True,
                                              idempotency_key=_key("starter-chips", template_id, str(n)))
        data = {s["tool"] for s in _tool_steps(under) if s.get("status") == "ok"} - {"app_help", "app_status"}
        second = _stream(starter_client, chip, origin="follow_up", persist_conversation=True,
                         conversation_id=under["conversation_id"],
                         idempotency_key=_key("starter-chips", template_id, chip))
        _assert_chip_answered(question, chip, data, second)


@pytest.mark.parametrize("question, title", [
    # Round 13 polish: one distinguishing detail, the window the lookup read.
    ("How is our security posture right now?", r"Security posture, last 24 hours"),
    ("What did the AI spend this week?", r"AI spend, this week"),
    ("Cases by severity in the last 7 days", r"Cases by severity, last 7 days"),
    # H1: the case's rule, never one generic title for every investigation, and
    # (Round 13 polish) the case's display number first, the rule id as written. The
    # seeded case carries the rule its Demo source raises (Round 14 FX3b2): a Splunk
    # risk rule id rides; an Entra rule name with spaces is never title text, so that
    # case falls back to its number alone.
    ("Investigate case demo-00000539-0005", r"CASE-\d{6} LP-ES-RISK-1006 case"),
    ("Give me an investigation brief for demo-00000539-0005", r"CASE-\d{6} brief, LP-ES-RISK-1006"),
    ("Investigate case demo-00000539-0004", r"CASE-\d{6} investigation"),
    # Product help names the console page it points to.
    ("How do I connect a new log source?", r"(?!Console help$)[A-Z][\w &-]* help"),
    ("Create a report on case volume and false positives for the last 7 days",
     r"Case volume and false positives report"),
])
def test_the_first_answer_titles_the_conversation(starter_client: TestClient, question: str, title: str) -> None:
    """T6: the first answer of a Workspace conversation names it (2 to 6 words, sentence
    case, engine words only); later answers keep that title."""
    first = _stream(starter_client, question, persist_conversation=True, idempotency_key=_key("title", question))
    named = first["conversation_title"]
    assert re.fullmatch(title, named) and parse_title({"title": named}) == named, named
    second = _stream(starter_client, "Which open cases need attention first, and why?", persist_conversation=True,
                     conversation_id=first["conversation_id"], idempotency_key=_key("title", question, "2"))
    assert second["conversation_title"] == named


def test_a_starter_titles_its_conversation(starter_client: TestClient) -> None:
    card = next(c for c in _home_cards(starter_client) if c["template"] == "sla_breached")
    response = _stream(starter_client, card["prompt"], origin="starter", persist_conversation=True,
                       idempotency_key=_key("title", "starter"))
    assert response["conversation_title"] == "Cases past their response target"


@pytest.mark.parametrize("template_id, title", [
    ("demo", "What Demo Mode simulates"), ("posture", "Security posture now"), ("weekly", "Last week compared"),
    ("explain_metric", "Active Risk Index explained"), ("connect_source", "Connecting a log source"),
])
def test_a_classified_starter_keeps_its_curated_title(starter_client: TestClient, template_id: str,
                                                      title: str) -> None:
    """H1: the starters classified like typed questions keep their curated titles, never
    the generic "Console help" or "Period comparison"."""
    question = starter_text.render_question(template_id, {})
    response = _stream(starter_client, question, origin="starter", persist_conversation=True,
                       idempotency_key=_key("title", template_id))
    assert response["conversation_title"] == title, response.get("conversation_title")


#: Golden first questions that differ in exactly one detail a title carries: their
#: conversations must be told apart in the history rail (Round 13 polish).
_TOLD_APART = [
    ("Search logs for mimikatz in September", "Search logs for mimikatz over all time"),            # window
    ("Show me the logs for host dc01 in the last 7 days", "Show me the logs for host dc01 in October"),
    ("Investigate case demo-00000539-0004", "Investigate case demo-00000539-0052"),                 # case number
    ("Which cases show T1078?", "Which cases show T1110?"),                                           # technique
    ("How many cases are open right now, grouped by severity?", "How many open cases by status?"),    # dimension
    ("Compare Q3 2026 vs Q2 2026", "Compare today with yesterday"),                                   # periods
    ("What is our TP rate?", "TP rate this quarter"),
    ("Investigate everything about host dc01 over the last 30 days", "Deep dive into user pnair this month"),
    ("How do I connect a new log source?", "How do I turn on single sign-on?"),                     # console page
]
#: The most golden first questions with a data answer one title may share, and the
#: least share of distinct titles among them (paraphrases of one ask legitimately share
#: one: "Compare this month vs last month" and "Is MTTR improving?").
_TITLE_MAX_SHARED, _TITLE_MIN_DISTINCT = 8, 0.65


def _question_values(question: str, ask: Any) -> list[str]:
    """The values a question carries that a title must never repeat: an indicator,
    an entity, a log search term, an internal case id, anything in backticks."""
    values = [str(v) for v in (ask.indicator[0] if ask.indicator else None,
                               ask.entity[1] if ask.entity else None, ask.keyword) if v]
    values += [str(v) for _k, v in ask.log_filter]
    values += re.findall(r"`([^`]+)`", question)
    values += re.findall(r"\b(?:demo|case)-[0-9a-z][\w.-]*", question)
    values += [m.group(0) for rx in (demo_chat._IPV4_RE, demo_chat._HASH_RE, demo_chat._URL_RE)
               for m in rx.finditer(question)]
    return [v for v in values if len(v) >= 3]


def test_first_question_titles_tell_conversations_apart(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    """Round 13 polish: the golden first questions get titles of 2 to 6 words that the
    title rules keep, carry one distinguishing detail where one exists (the history
    rail no longer shows a column of identical "Case list" rows), and never repeat a
    value the question carries (an indicator, entity, log term or internal id)."""
    from collections import Counter

    seen: list[tuple[Any, str]] = []
    real = demo_chat._conversation_title

    def spy(view: Any, ask: Any, final: Any) -> str:
        title = real(view, ask, final)
        seen.append((ask, title))
        return title

    monkeypatch.setattr(demo_chat, "_conversation_title", spy)
    titles: dict[str, str] = {}
    data: list[str] = []
    asked = [g for g in GOLDEN if not g.fields]
    extra = [q for pair in _TOLD_APART for q in pair if q not in {g.q for g in asked}]
    for question in [g.q for g in asked] + extra:
        seen.clear()
        response = _stream(client, question)
        ask, title = seen[-1]
        titles[question] = title
        assert title and 2 <= len(title.split()) <= 6 and parse_title({"title": title}) == title, (question, title)
        assert not re.search(r"\b(?:demo|case)-[0-9a-z]", title), (question, title)
        number = re.search(r"\bCASE-\d+", title)
        # The case number leads: the history rail cuts a title at about 26 characters.
        assert number is None or number.end() <= 24, (question, title)
        for value in _question_values(question, ask):
            assert not re.search(rf"(?<![\w-]){re.escape(value)}(?![\w-])", title), (question, value, title)
        if question in {g.q for g in asked} and response.get("answer_kind") in ("data", "mixed"):
            data.append(title)
    for first, second in _TOLD_APART:
        assert titles[first] != titles[second], (first, second, titles[first])
    shared = Counter(data).most_common(1)[0]
    assert shared[1] <= _TITLE_MAX_SHARED, shared
    assert len(set(data)) >= _TITLE_MIN_DISTINCT * len(data), (len(set(data)), len(data), Counter(data).most_common(5))


def test_the_demo_card_answer_says_what_is_simulated(starter_client: TestClient) -> None:
    """The Demo Mode card's answer leads with what Demo Mode simulates (the Help Center),
    not with a settings page, and shows no deployment source counts that contradict the
    Demo sources streaming beside it."""
    response = _stream(starter_client, starter_text.render_question("demo", {}), origin="starter")
    answer = response["answer"]
    assert not answer.startswith("Start in"), answer[:200]
    assert "synthetic" in answer.lower() or "simulated" in answer.lower(), answer[:400]
    assert not [b for b in response.get("blocks") or [] if b.get("type") == "kpi_group"
                and b.get("title") == "Deployment"], response.get("blocks")


def test_a_volume_and_false_positives_report_covers_both(starter_client: TestClient) -> None:
    """T37: "case volume and false positives" counts every case (no verdict filter),
    names the false positives among them, and its next steps come from its figures."""
    response = _stream(starter_client, "Create a report on case volume and false positives for the last 7 days",
                       persist_conversation=True, idempotency_key=_key("t37", "1"))
    steps = _tool_steps(response)
    assert all("verdict" not in (s.get("params") or {}) for s in steps), steps
    total = _store_count(starter_client, "now-7d", {})
    fp = _store_count(starter_client, "now-7d", {"verdict": "FALSE_POSITIVE"})
    answer = response["answer"]
    assert answer.startswith(f"**{total:,} cases** in the last 7 days"), answer[:200]
    assert f", {fp:,} of them false positives" in answer, answer[:200]
    envelope = next(b for b in response["blocks"] if b.get("type") == "report")
    assert envelope["title"].startswith("Case volume and false positives")
    steps_text = next(i["text"] for s in envelope["sections"] if s["heading"] == "Next steps"
                      for i in (s.get("blocks") or s.get("items") or []) if i.get("type") == "markdown")
    assert "Verify the figures in the console" not in steps_text and re.search(r"\d", steps_text), steps_text
    if fp and fp / total >= 0.5:
        assert f"{fp:,} false positives" in steps_text, steps_text


@pytest.mark.parametrize("question, follow, dropped", [
    ("Show events from 198.51.100.77 in the last hour", "Show the same without the source IP filter", "ip"),
    ("How many open critical false positives this week?", "Show the same for open and closed cases",
     "status_group"),
])
def test_a_zero_result_chip_drops_the_filter_its_label_names(starter_client: TestClient, question: str,
                                                              follow: str, dropped: str) -> None:
    """Round 13 B note: a zero-result chip names a field in display words ("source
    IP", "Open and closed cases"); the rerun maps them back to the input key."""
    first = _stream(starter_client, question, persist_conversation=True, idempotency_key=_key("zero13", question))
    # The console's zero-result chip sends exactly this question (``suggestion_question``).
    second = _stream(starter_client, follow, origin="follow_up", persist_conversation=True,
                     conversation_id=first["conversation_id"], idempotency_key=_key("zero13", question, "2"))
    reran = [s for s in _tool_steps(second) if s["tool"] in ("search_logs", "case_stats", "search_cases")]
    assert reran and all(dropped not in (s.get("params") or {}) for s in reran), reran
    assert second["answer"].startswith("Re-ran the earlier lookups"), second["answer"][:200]


# --------------------------------------------------------------------------- #
# Round 13 final review (WP-DEMO13): chips answered for the answer they sit under.
# --------------------------------------------------------------------------- #
_STILL_OPEN = "Which of these cases are still open?"


@pytest.mark.parametrize("question, kept", [
    ("List the escalated cases", {"status": "escalated"}),
    ("List the on hold cases in the last 30 days", {"status": "on_hold", "window": "now-30d"}),
    ("List the cases from the last 7 days", {"status_group": "active", "window": "now-7d"}),
])
def test_the_still_open_chip_keeps_the_earlier_list_filter(starter_client: TestClient, question: str,
                                                           kept: dict[str, Any]) -> None:
    """SPEC §4.1: "these cases" are the earlier list's cases. An open status it was
    filtered by stays the filter (never the whole open queue), the count stated is at
    most the earlier list's open count, and the chip is offered only under a list that
    holds open and closed cases."""
    first = _stream(starter_client, question, persist_conversation=True, idempotency_key=_key("open13", question))
    earlier = next(s.get("params") or {} for s in _tool_steps(first) if s["tool"] == "search_cases")
    window, status = earlier.get("window"), earlier.get("status")
    total = _store_count(starter_client, window, {"status": status} if status else {})
    open_before = _store_count(starter_client, window, {"status": status} if status else {"status_group": "active"})
    assert (_STILL_OPEN in first["follow_ups"]) == (0 < open_before < total), (first["follow_ups"], open_before,
                                                                               total)
    second = _stream(starter_client, _STILL_OPEN, origin="follow_up", persist_conversation=True,
                     conversation_id=first["conversation_id"], idempotency_key=_key("open13", question, "2"))
    steps = _tool_steps(second)
    assert _matched_step(steps, "search_cases", kept) is not None, [(s["tool"], s.get("params")) for s in steps]
    assert all("status_group" not in (s.get("params") or {}) for s in steps if status), steps
    stated = re.match(r"\*\*([\d,]+) cases?\*\*", second["answer"])
    assert stated and int(stated.group(1).replace(",", "")) <= open_before, (second["answer"][:200], open_before)


def test_the_still_open_chip_under_a_closed_list_says_none_is_open(starter_client: TestClient) -> None:
    question = "List the closed cases from the last 30 days"
    first = _stream(starter_client, question, persist_conversation=True, idempotency_key=_key("open13", question))
    assert _STILL_OPEN not in first["follow_ups"], first["follow_ups"]
    second = _stream(starter_client, "Which of these cases are still open, and who has them?", origin="follow_up",
                     persist_conversation=True, conversation_id=first["conversation_id"],
                     idempotency_key=_key("open13", question, "2"))
    assert second["answer"].startswith("None of those cases is still open"), second["answer"][:200]
    assert not _tool_steps(second), _tool_steps(second)


@pytest.mark.parametrize("question, kept", [
    ("How many escalated cases this month?", {"status": "escalated", "window": "this_month"}),
    ("How many false positives in the last 30 days?", {"verdict": "FALSE_POSITIVE", "window": "now-30d"}),
    ("List the cases from the last 7 days", {"window": "now-7d"}),
])
def test_a_compare_chip_under_a_case_answer_compares_those_cases(starter_client: TestClient, question: str,
                                                                  kept: dict[str, Any]) -> None:
    """SPEC §4.1: "Compare this with the previous {period}" under a case count or a case
    list compares THOSE cases (the earlier lookup's filters and window) with the period
    before, never every case."""
    first = _stream(starter_client, question, persist_conversation=True, idempotency_key=_key("cmp13", question))
    # A case list offers no comparison chip (search_cases is not a compared lookup), but
    # the same words typed under it are answered the same way.
    period = {"this_month": "month", "now-30d": "30 days", "now-7d": "7 days"}[kept["window"]]
    chip = next((c for c in first["follow_ups"] if c.startswith("Compare this with the previous")),
                f"Compare this with the previous {period}")
    assert chip == f"Compare this with the previous {period}", chip
    second = _stream(starter_client, chip, origin="follow_up", persist_conversation=True,
                     conversation_id=first["conversation_id"], idempotency_key=_key("cmp13", question, "2"))
    steps = [s for s in _tool_steps(second) if s.get("status") == "ok"]
    compared = [s for s in steps if (s.get("params") or {}).get("compare") == "previous_period"]
    assert compared and all(s["tool"] == "case_stats" for s in compared), steps
    assert all(_has(s.get("params"), kept) for s in compared), (kept, [s.get("params") for s in compared])
    assert not any(s["tool"] == "soc_metrics" for s in steps), steps
    total = _store_count(starter_client, kept["window"], {k: v for k, v in kept.items() if k != "window"})
    assert f"**{total:,}**" in second["answer"], (total, second["answer"][:300])


def test_the_noisy_rule_compare_chip_compares_that_rule(starter_client: TestClient) -> None:
    slots = _starter_slots(starter_client)["noisy_rule"]
    question = starter_text.render_question("noisy_rule", slots)
    first = _stream(starter_client, question, origin="starter", persist_conversation=True,
                    idempotency_key=_key("cmp13", "noisy"))
    chip = next((c for c in first["follow_ups"] if c.startswith("Compare this with the previous")), None)
    if chip is None:
        chip = "Compare this with the previous 24 hours"
    second = _stream(starter_client, chip, origin="follow_up", persist_conversation=True,
                     conversation_id=first["conversation_id"], idempotency_key=_key("cmp13", "noisy", "2"))
    compared = [s for s in _tool_steps(second) if (s.get("params") or {}).get("compare") == "previous_period"]
    assert compared and all((s.get("params") or {}).get("rule") == slots["rule"] for s in compared), compared
    assert f"`{slots['rule']}`" in second["answer"] or slots["rule"] in second["answer"], second["answer"][:300]


def _case_chat_turn(client: TestClient, case_id: str, history: list[dict[str, Any]], question: str,
                    origin: str) -> dict[str, Any]:
    response = _stream(client, question, origin=origin, case_id=case_id, history=history)
    history.extend([{"role": "user", "content": question, "origin": origin},
                    {"role": "assistant", "content": response["answer"]}])
    return response


def test_case_chat_compare_and_its_chips_are_answered_for_the_case_entity(starter_client: TestClient) -> None:
    """A Case Manager chat replays no lookup digest: "Compare this with the previous 24
    hours" under the case_entity answer compares the case's main entity's log activity
    with the period before (never the case summary again), and the chips under that
    comparison stay on that entity and keep its window."""
    case = next(c for c in _store_cases(starter_client)
                if _status(c) in ACTIVE_STATUSES and _verdict(c) == "NEEDS_HUMAN" and c.entity)
    value = case.entity.value
    history: list[dict[str, Any]] = []
    first = _case_chat_turn(starter_client, case.case_id, history, starter_text.render_question("case_entity", {}),
                            "starter")
    chip = next(c for c in first["follow_ups"] if c.startswith("Compare this with the previous"))
    compared = _case_chat_turn(starter_client, case.case_id, history, chip, "follow_up")
    ok = [s for s in _tool_steps(compared) if s.get("status") == "ok"]
    stats = next(s for s in ok if s["tool"] == "log_stats")
    assert (stats.get("params") or {}).get("compare") == "previous_period", stats
    assert value in json.dumps(stats.get("params")), (value, stats)
    assert not any(s["tool"] == "explain_decision" for s in ok), ok
    assert "period before" in compared["answer"], compared["answer"][:300]
    assert compared["follow_ups"], compared["answer"][:300]
    for chip in compared["follow_ups"]:
        response = _case_chat_turn(starter_client, case.case_id, list(history), chip, "follow_up")
        ok = [s for s in _tool_steps(response) if s.get("status") == "ok"]
        assert not any(s["tool"] == "explain_decision" for s in ok), (chip, ok)
        logs = [s for s in ok if s["tool"] in ("log_stats", "search_logs")]
        assert logs, (chip, ok)
        # The first log lookup is about the case's own entity (a top value follows it).
        assert value in json.dumps(logs[0].get("params")), (chip, logs[0])
        if chip.startswith("Show the same for the last 7 days"):
            assert all((s.get("params") or {}).get("time_from") == "now-7d" for s in logs), (chip, logs)
            assert (logs[0].get("params") or {}).get("compare") == "previous_period", (chip, logs)


def test_case_chat_still_open_chip_lists_the_open_cases_on_the_entity(starter_client: TestClient) -> None:
    case = next(c for c in _store_cases(starter_client) if c.case_id == "demo-recent-00000539-0000")
    value = case.entity.value
    history: list[dict[str, Any]] = []
    first = _case_chat_turn(starter_client, case.case_id, history, starter_text.render_question("case_related", {}),
                            "starter")
    chip = "Which of these cases are still open, and who has them?"
    response = _case_chat_turn(starter_client, case.case_id, history, chip, "follow_up")
    found = _matched_step(_tool_steps(response), "search_cases", {"entity": value, "status_group": "active"})
    assert found is not None, _tool_steps(response)
    open_on_entity = sum(1 for c in _store_cases(starter_client)
                         if _status(c) in ACTIVE_STATUSES and value in json.dumps(c.model_dump(mode="json")))
    stated = re.match(r"\*\*([\d,]+) cases?\*\*", response["answer"])
    assert stated and int(stated.group(1)) <= open_on_entity, (response["answer"][:200], open_on_entity)
    assert chip in first["follow_ups"], first["follow_ups"]


def test_show_the_same_under_a_comparison_keeps_it_and_the_takeaway_rule(starter_client: TestClient) -> None:
    """SPEC §4.1: "Show the same for the {next window}" is offered after a comparison ran
    and re-runs that comparison over the window named; its prose names at most two of
    the figures its key-figure blocks show (T15)."""
    question = starter_text.render_question("weekly", {})
    first = _stream(starter_client, question, origin="starter", persist_conversation=True,
                    idempotency_key=_key("same13", "weekly"))
    chip = "Show the same for the last 30 days"
    assert chip in first["follow_ups"], first["follow_ups"]
    second = _stream(starter_client, chip, origin="follow_up", persist_conversation=True,
                     conversation_id=first["conversation_id"], idempotency_key=_key("same13", "weekly", "2"))
    steps = [s for s in _tool_steps(second) if s.get("status") == "ok"]
    assert steps and all(_has(s.get("params"), {"window": "now-30d", "compare": "previous_period"})
                         for s in steps), steps
    assert not _t15_violations(second["answer"], second.get("blocks")), (
        _t15_violations(second["answer"], second.get("blocks")), second["answer"][:400])


def test_a_case_count_answer_beside_its_key_figures_names_two_of_them(starter_client: TestClient) -> None:
    """T15 on the rerun path: the same summary lookups re-run without a comparison (a
    widening chip) state the count and one more figure beside the Case figures block."""
    question = "How did last week compare with the week before?"
    first = _stream(starter_client, question, persist_conversation=True, idempotency_key=_key("same13", "plain"))
    second = _stream(starter_client, "Show the same for all time", origin="follow_up", persist_conversation=True,
                     conversation_id=first["conversation_id"], idempotency_key=_key("same13", "plain", "2"))
    assert all("compare" not in (s.get("params") or {}) for s in _tool_steps(second)), _tool_steps(second)
    total = _store_count(starter_client, "all", {})
    assert f"**{total:,} cases** over all time" in second["answer"], second["answer"][:300]
    assert not _t15_violations(second["answer"], second.get("blocks")), (
        _t15_violations(second["answer"], second.get("blocks")), second["answer"][:400])


def test_a_technique_answer_shows_every_case_it_lists(starter_client: TestClient) -> None:
    """Every case the prose lists is in a block, and a list shorter than the count says
    which part of it it is ("The 5 highest-risk of the 11")."""
    response = _stream(starter_client, "Which cases show T1078?")
    answer = response["answer"]
    # A listed case is named by its display number (every seeded Demo case has one).
    listed = re.findall(r"^- .*?`((?:CASE-\d+|demo-[\w-]+))`", answer, re.MULTILINE)
    count = int(re.search(r"appears in \*\*(\d+) cases?\*\*", answer).group(1))  # type: ignore[union-attr]
    shown = {ref for b in response["blocks"] if b.get("type") == "case_list"
             for i in (b.get("items") or []) for ref in (i.get("case_id"), i.get("case_number")) if ref}
    assert listed and set(listed) <= shown, (listed, shown)
    if len(listed) < count:
        assert re.search(rf"\b{len(listed)} highest-risk\b.*\bof the {count}\b", answer), answer[:500]
    titles = [b.get("title") for b in response["blocks"] if b.get("type") == "case_list"]
    assert titles and all(t.startswith("Cases with T1078") for t in titles), titles


def test_the_closed_why_chip_never_contradicts_who_closed_the_case(starter_client: TestClient) -> None:
    """A case closed by the AI agent that today's policy would send to a human is said
    once, reconciled; the decider is named once and never as a raw enum."""
    closed = [c for c in _store_cases(starter_client) if _status(c) == "closed"
              and str(getattr(c.decision_by, "value", c.decision_by)) == "agent"]
    question = starter_text.render_question("case_closed_why", {})
    for case in closed[:6]:
        answer = _stream(starter_client, question, origin="starter", case_id=case.case_id)["answer"]
        assert "recorded by" not in answer, answer[:500]
        if "would go to a human" in answer:
            assert "it was closed by the AI agent; under today's policy" in answer, answer[:500]
            assert "Who decided" not in answer, answer[:500]
        assert answer.count("the AI agent") == 1, answer[:500]


def test_the_rebucket_chip_under_a_since_window_is_by_hour_or_day(starter_client: TestClient) -> None:
    slots = _starter_slots(starter_client)["new_cases_one"]
    question = starter_text.render_question("new_cases_one", slots)
    first = _stream(starter_client, question, origin="starter", persist_conversation=True,
                    idempotency_key=_key("clock13", "1"))
    chip = next(c for c in first["follow_ups"] if c.endswith(" by rule"))
    second = _stream(starter_client, chip, origin="follow_up", persist_conversation=True,
                     conversation_id=first["conversation_id"], idempotency_key=_key("clock13", "2"))
    rebucket = [c for c in second["follow_ups"] if c.startswith("Show these cases")]
    assert rebucket and all(re.search(r" by (?:hour|day)$", c) for c in rebucket), second["follow_ups"]


@pytest.mark.parametrize("question, filter_word", [
    ("Show the SLA breaches for critical cases", "severity"),
    ("Which of my cases are past their SLA?", "yours"),
])
def test_a_filtered_sla_question_says_the_filter_was_not_applied(starter_client: TestClient, question: str,
                                                                  filter_word: str) -> None:
    response = _stream(starter_client, question)
    breached = int(_sla_totals(starter_client).get("breached") or 0)
    answer = response["answer"]
    assert answer.startswith(f"**{breached:,} case"), answer[:200]
    assert "The shift snapshot cannot" in answer and filter_word in answer, answer[:400]


@pytest.fixture(scope="module")
def half_risk_client() -> Iterator[TestClient]:
    """A Demo app whose newest escalated case has a risk of exactly 98.5, the value
    Python's half-to-even rounding would state as 98 (Round 13 T1)."""
    from app.constants import CaseStatus, EntityType, SourceSurface, Verdict
    from app.models import Case, Entity, StatusHistoryEntry

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
        now = datetime.now(UTC)
        await state.cases.save(Case(
            case_id="case-half-risk", cluster_signature="sig-half-risk", source_surface=SourceSurface.INVESTIGATE,
            entity=Entity(type=EntityType.IP, value="198.51.100.7"),
            created_at=(now - timedelta(minutes=5)).isoformat(), updated_at=now.isoformat(),
            status=CaseStatus.ESCALATED, verdict=Verdict.TRUE_POSITIVE, risk_score=98.5, confidence=0.9,
            rule_ids=["half_risk_rule"],
            status_history=[StatusHistoryEntry(from_status="open", to_status="escalated", at=now.isoformat())],
        ))
        app.state.tlsoc = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    for router in (base_router, chat_router, library_router, reports_router, starters_router):
        api.include_router(router)
    try:
        with TestClient(api) as test_client:
            yield test_client
    finally:
        patch.undo()


def test_a_half_risk_is_one_integer_on_the_card_the_steps_and_the_answer(half_risk_client: TestClient) -> None:
    """Risk 98.5 reads 99 everywhere in one turn: the needs-human card's reason line,
    the get_case and explain_decision step summaries and the Demo answer (round half
    up, like the gauge; SPEC-chat §3.7, §5.3 T1)."""
    info = half_risk_client.get("/api/chat/starters", params={"surface": "home"}).json()
    card = next(c for c in info["starters"] if c["id"] == "needs_human")
    assert card["ref"]["value"] == "case-half-risk" and card["reason"].endswith("risk 99"), card
    response = _stream(half_risk_client, card["prompt"], origin="starter")
    summaries = {s.get("tool"): str(s.get("summary") or "") for s in _tool_steps(response)}
    assert "risk 99" in summaries.get("get_case", ""), summaries
    assert "risk 99 " in summaries.get("explain_decision", ""), summaries
    answer = response["answer"]
    assert "risk 99/100" in answer, answer[:500]
    assert not re.search(r"\brisk 98\b", answer), answer[:500]
    assert all(not re.search(r"\brisk 98\b", s) for s in summaries.values()), summaries


# --------------------------------------------------------------------------- #
# Round 13 close (CB): the figures of one answer agree; an entity investigation's
# campaigns are its own; "my cases" right after an assignment lists what it counts.
# --------------------------------------------------------------------------- #
def _console_percent(value: float) -> str:
    """The console's percent tile (``format.ts`` ``pct``): "<1%" for a sliver, one
    decimal under 10%, whole from 10% up, rounded half up."""
    if 0 < value < 1:
        return "<1%"
    places = 1 if abs(value) < 10 else 0
    quantized = Decimal(str(round(value, 6))).quantize(Decimal(1).scaleb(-places), rounding=ROUND_HALF_UP)
    text = f"{quantized:,.{places}f}"
    return (text.rstrip("0").rstrip(".") if places else text) + "%"


def _kpi_items(blocks: Any, title: str) -> dict[str, dict[str, Any]]:
    """The items of the key-figure group titled ``title`` (inside a report too), by key."""
    group = next((g for g in _t15_groups(blocks) if g.get("title") == title), None)
    return {str(i.get("key")): i for i in (group or {}).get("items") or [] if isinstance(i, dict)}


def _report_blocks(blocks: Any) -> Iterator[dict[str, Any]]:
    for block in blocks or []:
        if not isinstance(block, dict):
            continue
        yield block
        if block.get("type") == "report":
            for section in block.get("sections") or []:
                yield from _report_blocks((section.get("blocks") or []) + (section.get("items") or []))


def test_the_shift_brief_states_each_figure_as_its_tiles_do(starter_client: TestClient) -> None:
    """The shift headline's "Needs human" counts the open cases whose verdict is Needs
    human (the badge the Needs attention list shows), never a status count of 0 beside
    ten such badges; the Next steps state the false-positive rate as the posture tile
    shows it ("78%", never "77.5%")."""
    response = _stream(starter_client, "Give me a shift handover report")
    blocks = response.get("blocks")
    headline = _kpi_items(blocks, "Shift headline")
    assert "needs_human_verdict" in headline and "needs_human" not in headline, sorted(headline)
    store = _store_cases(starter_client)
    awaiting = sum(1 for c in store if _status(c) in ACTIVE_STATUSES
                   and str(getattr(c.verdict, "value", c.verdict) or "").upper() == "NEEDS_HUMAN")
    assert headline["needs_human_verdict"]["label"] == "Needs human"
    assert headline["needs_human_verdict"]["value"] == awaiting, (headline["needs_human_verdict"], awaiting)
    attention = next(b for b in _report_blocks(blocks) if b.get("type") == "case_list"
                     and b.get("title") == "Needs attention")
    badges = sum(1 for i in attention.get("items") or [] if i.get("verdict") == "needs_human")
    assert badges <= awaiting, (badges, awaiting)
    posture = _kpi_items(blocks, "Security posture")
    steps = "\n".join(t for t in _report_texts(blocks) if t.lstrip().startswith("1. "))
    assert steps, list(_report_texts(blocks))
    said = re.search(r"false-positive rate is ([^:]+):", steps)
    if said is not None:
        assert said.group(1) == _console_percent(posture["fp_rate"]["value"]), (said.group(1), posture["fp_rate"])
    if awaiting:
        assert f"Give a verdict on the {awaiting:,} open case" in steps, steps
    assert "Needs human status" not in steps + response["answer"], steps
    assert not _figure_form_violations(response), _figure_form_violations(response)


def test_an_entity_investigation_lists_only_the_campaigns_that_involve_it(starter_client: TestClient) -> None:
    """The pnair deep dive's campaign table holds only the campaigns that involve user
    pnair (a shared entity, or a member case about pnair), titled for the user, and the
    prose counts the same campaigns; other campaigns stay out of it."""
    from app.models import Campaign, CampaignEntity

    state = _state(starter_client)
    pnair_cases = [c for c in _store_cases(starter_client) if str(getattr(c.entity, "value", "")) == "pnair"]
    other_cases = [c for c in _store_cases(starter_client) if str(getattr(c.entity, "value", "")) not in ("pnair", "")]
    assert pnair_cases and len(other_cases) >= 4
    now = datetime.now(UTC).isoformat()
    seeded = [
        Campaign(id="campaign-close-shared", case_ids=[other_cases[0].case_id, other_cases[1].case_id],
                 entities=[CampaignEntity(entity_type="user", value="pnair")], mitre=["T1078"],
                 first_seen=now, last_seen=now, created_at=now),
        Campaign(id="campaign-close-member", case_ids=[pnair_cases[0].case_id, other_cases[2].case_id],
                 entities=[CampaignEntity(entity_type="ip", value="198.51.100.230")],
                 first_seen=now, last_seen=now, created_at=now),
        Campaign(id="campaign-close-other", case_ids=[other_cases[3].case_id, other_cases[1].case_id],
                 entities=[CampaignEntity(entity_type="ip", value="203.0.113.230")],
                 first_seen=now, last_seen=now, created_at=now),
    ]
    starter_client.portal.call(lambda: state.campaign_store.upsert_many(seeded))
    try:
        response = _stream(starter_client, "Investigate the activity of user pnair in the last 3 days")
        steps = [s for s in _tool_steps(response) if s["tool"] == "list_campaigns"]
        assert steps and all((s.get("params") or {}).get("entity") == "pnair" for s in steps), steps
        tables = [b for b in _report_blocks(response.get("blocks")) if b.get("type") == "table"
                  and "campaign" in str(b.get("title") or "").lower()]
        assert len(tables) == 1 and tables[0]["title"] == "Campaigns involving this user", \
            [b.get("title") for b in tables]
        every, _total = starter_client.portal.call(lambda: state.campaign_store.list())
        by_label = {(c.name or c.id): c for c in every}
        about = {c.case_id for c in pnair_cases}
        listed = [by_label[str(row[0])] for row in tables[0].get("rows") or []]
        assert listed, tables[0]
        for camp in listed:
            assert (any(e.value.lower() == "pnair" for e in camp.entities) or about & set(camp.case_ids)), camp.id
        ids = {c.id for c in listed}
        assert {"campaign-close-shared", "campaign-close-member"} <= ids and "campaign-close-other" not in ids, ids
        said = re.search(r"Campaigns involving it: \*\*(\d+) campaigns?\*\*", response["answer"])
        assert said is not None and int(said.group(1)) == len(listed), response["answer"][-800:]
    finally:
        async def drop() -> None:
            for camp in seeded:
                await state.campaign_store.delete(camp.id)
        starter_client.portal.call(drop)


def test_my_cases_right_after_an_assignment_lists_every_case_it_counts(signed_in_client: TestClient) -> None:
    """The count of "my cases" and the cases listed under it describe the same cases
    when the question follows an assignment within seconds (the shared case page is
    read again when it predates the count): never "4 open cases are assigned to you"
    with three listed."""
    mine = _my_open_cases(signed_in_client)
    starters = signed_in_client.get("/api/chat/starters", params={"surface": "home"}).json()["starters"]
    card = next(c for c in starters if c.get("template") == "my_cases")
    _stream(signed_in_client, card["prompt"], origin="starter")  # the shared case page is now warm
    spare = next(c for c in sorted(_store_cases(signed_in_client), key=lambda c: c.case_id)
                 if _status(c) in ACTIVE_STATUSES and not str(c.assignee or "").strip())
    try:
        assigned = signed_in_client.post(f"/api/cases/{spare.case_id}/assign", json={"assignee": _ME})
        assert assigned.status_code == 200, assigned.text
        response = _stream(signed_in_client, card["prompt"], origin="starter")
        now_mine = _my_open_cases(signed_in_client)
        assert len(now_mine) == len(mine) + 1
        (step,) = [s for s in _tool_steps(response) if s["tool"] == "search_cases"]
        assert step["status"] == "ok", step
        assert response["answer"].startswith(f"**{len(now_mine)} open cases** are assigned to you."), \
            response["answer"][:300]
        (listed,) = [b for b in response["blocks"] if b.get("type") == "case_list"]
        assert sorted(i.get("case_number") for i in listed.get("items") or []) == \
            sorted(c.case_number for c in now_mine), listed
    finally:
        async def release() -> None:
            case = await _state(signed_in_client).cases.get(spare.case_id)
            await _state(signed_in_client).cases.save(case.model_copy(update={"assignee": ""}))
        signed_in_client.portal.call(release)
        from app.api.metrics_shared import invalidate_case_page_cache

        invalidate_case_page_cache()
