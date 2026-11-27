"""Round 16 Help Center: the pages describe the code that ships (WP18C review).

Each check reads the code fact first (a route's grants, a Console constant or label, a
clock rule, the risk function) and then the Help Center sentence that states it, so a
page cannot drift from the code it documents. Offline: reads repository files and
imports modules only.
"""

from __future__ import annotations

import re
from pathlib import Path

import app
from app.api import routes_case_events, routes_case_usage
from app.config import Preferences
from app.engine.metrics import _RESPONSE_STATUSES
from app.engine.risk import compute_risk
from app.models import CASE_EVENTS_MAX_LIMIT, Cluster

REPO_ROOT = Path(app.__file__).resolve().parents[2]
DOCS = REPO_ROOT / "docs"
WEBUI = REPO_ROOT / "webui" / "src"

CASE_MANAGER_MD = DOCS / "analyst" / "case-manager.md"
EXPLAINABLE_MD = DOCS / "analyst" / "explainable-numbers.md"
ANALYTICS_MD = DOCS / "analyst" / "analytics.md"
KPI_GLOSSARY_MD = DOCS / "analyst" / "kpi-glossary.md"
API_MD = DOCS / "reference" / "api.md"
PERMISSIONS_MD = DOCS / "reference" / "permissions.md"
STATE_COST_MD = DOCS / "concepts" / "state-audit-cost.md"
AUTHENTICATION_MD = DOCS / "administration" / "authentication.md"
KNOWN_LIMITS_MD = DOCS / "releases" / "known-limitations.md"

CASE_RECORDS_API_TS = WEBUI / "lib" / "api-case-records.ts"
CASE_EVENTS_TSX = WEBUI / "soc" / "pages" / "casedetail" / "records" / "CaseEvents.tsx"
CASE_USAGE_TSX = WEBUI / "soc" / "pages" / "casedetail" / "records" / "CaseUsageButton.tsx"
METRICS_TSX = WEBUI / "soc" / "pages" / "Metrics.tsx"


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _flat(text: str) -> str:
    """Markdown with its line breaks folded, so a sentence reads as one string."""
    return re.sub(r"\s+", " ", text)


def _section(text: str, heading: str) -> str:
    """The body of one ``##`` or ``###`` section, up to the next heading of any level."""
    match = re.search(rf"^#+ {re.escape(heading)}\n(.*?)(?=^#+ |\Z)", text, re.M | re.S)
    assert match, f"no section {heading!r}"
    return match.group(1)


def _bullet(text: str, lead: str) -> str:
    """One top-level list item that starts with ``lead``, folded to one line."""
    match = re.search(rf"^- {re.escape(lead)}(.*?)(?=^- |^\S|\Z)", text, re.M | re.S)
    assert match, f"no bullet starting {lead!r}"
    return _flat(lead + match.group(1))


def _route_grants(router, path: str) -> list[str]:
    """The ``resource:action`` grants a route's ``require_permission`` dependencies ask for."""
    for route in router.routes:
        if getattr(route, "path", None) != path:
            continue
        grants = []
        for dependency in route.dependant.dependencies:
            call = dependency.call
            names = getattr(getattr(call, "__code__", None), "co_freevars", ())
            if set(names) >= {"resource", "action"} and call.__closure__:
                cells = dict(zip(names, (cell.cell_contents for cell in call.__closure__)))
                grants.append(f"{cells['resource']}:{cells['action']}")
        return grants
    raise AssertionError(f"no route {path}")


def _grant_words(grants: list[str]) -> str:
    return " and ".join(f"`{grant}`" for grant in grants)


def test_the_events_table_reads_the_console_page_size_not_the_api_limit():
    # The Console asks for CASE_EVENTS_PAGE rows and offers "Load more events" for the
    # rest; the API's 200 is the largest page a client may ask for, not what the table shows.
    page = re.search(r"export const CASE_EVENTS_PAGE = (\d+);", _read(CASE_RECORDS_API_TS))
    assert page, "CASE_EVENTS_PAGE not found"
    size = int(page.group(1))
    assert "Load more events" in _read(CASE_EVENTS_TSX)

    events = _bullet(_section(_read(CASE_MANAGER_MD), "Every record of a case"), "**Events.**")
    assert f"{size} at a time" in events
    assert "**Load more events**" in events
    assert f"up to {CASE_EVENTS_MAX_LIMIT} to a page" not in events

    api = _flat(_read(API_MD))
    assert (
        f"`limit` (1 to {CASE_EVENTS_MAX_LIMIT}, default {routes_case_events.DEFAULT_LIMIT})" in api
    )


def test_the_case_records_routes_name_every_grant_they_ask_for():
    usage = _grant_words(_route_grants(routes_case_usage.router, "/api/cases/{case_id}/usage"))
    events = _grant_words(_route_grants(routes_case_events.router, "/api/cases/{case_id}/events"))
    assert usage == "`cases:read` and `cost:view`"
    assert events == "`cases:read` and `sources:read`"

    api = _flat(_read(API_MD))
    assert f"`GET /api/cases/{{case_id}}/usage` ({usage})" in api
    assert f"`GET /api/cases/{{case_id}}/events` ({events})" in api

    rows = [line for line in _read(PERMISSIONS_MD).splitlines() if line.startswith("|")]
    usage_row = next(line for line in rows if "/api/cases/{case_id}/usage" in line)
    events_row = next(line for line in rows if "/api/cases/{case_id}/events" in line)
    assert usage_row.rstrip(" |").endswith(usage)
    assert events_row.rstrip(" |").endswith(events)

    state = _flat(_read(STATE_COST_MD))
    assert f"`GET /api/cases/{{case_id}}/usage` ({usage})" in state

    records = _section(_read(CASE_MANAGER_MD), "Every record of a case")
    assert f"You need {usage}" in _bullet(records, "**AI usage.**")
    assert f"You need {events}" in _bullet(records, "**Events.**")


def test_the_sla_page_names_every_status_move_that_stops_the_response_clock():
    # metrics.first_human_response stops the response clock at a person's move into any
    # of _RESPONSE_STATUSES (resolved and closed included), and sla_case_reading stops it
    # at the close of a case nobody answered. The explanation page and the KPI glossary
    # must both say so.
    statuses = sorted(status.replace("_", " ") for status in _RESPONSE_STATUSES)
    assert {"resolved", "closed", "on hold"} <= set(statuses)

    sla = _flat(_section(_read(EXPLAINABLE_MD), "SLA clocks"))
    stop = re.search(r"It stops at the first human response:(.*?)\. ", sla)
    assert stop, "the response clock stop sentence is missing"
    for status in statuses:
        assert status in stop.group(1).lower(), f"{status!r} missing from the stop rule"
    assert "the response clock stops at the close" in sla

    glossary = _flat(_section(_read(KPI_GLOSSARY_MD), "SLA attainment"))
    glossary_stop = re.search(r"It stops at the first human response:(.*?)\. ", glossary)
    assert glossary_stop
    for status in statuses:
        assert status in glossary_stop.group(1).lower()


def test_the_worked_risk_example_is_what_compute_risk_returns():
    start = 1_764_147_300_000
    cluster = Cluster(
        signature="worked-example",
        entity={"type": "ip", "value": "203.0.113.9"},
        group_by="ip",
        rule_values=["ssh-bruteforce", "port-scan"],
        count=12,
        first_seen_millis=start,
        last_seen_millis=start + 300_000,
    )
    risk = compute_risk(cluster, Preferences(), 40)
    example = _flat(_section(_read(EXPLAINABLE_MD), "Worked example"))
    assert f"100 x 0.6524 = {risk.volume:g}" in example
    assert f"100 x 2.4 / 10 = {risk.velocity:g}" in example
    assert f"100 x 2 / 5 = {risk.diversity:g}" in example
    assert f"= {risk.total:g}" in example
    assert f"floor({risk.total:g} + 0.5) = {int(risk.total + 0.5)}" in example


def test_analytics_pages_do_not_claim_every_figure_explains_itself():
    # Some Analytics tiles carry no explanation (a KpiTile with no `explain` slot), so the
    # pages may not promise that every figure on Analytics shows its formula.
    unexplained = [
        line for line in _read(METRICS_TSX).splitlines()
        if "<KpiTile label=" in line and "explain=" not in line
    ]
    if not unexplained:
        return
    analytics = _flat(_read(ANALYTICS_MD))
    assert "Every figure on these pages explains itself" not in analytics
    where = _flat(_section(_read(EXPLAINABLE_MD), "Where to see a calculation"))
    assert not re.search(r"on \*\*Analytics\*\*[^.]*every figure", where, re.I)


def test_an_older_ledger_row_is_said_to_keep_its_stored_cost():
    # A row written before the rates were recorded shows its stored cost; nothing reprices it.
    assert "The cost is shown as stored." in _read(CASE_USAGE_TSX)
    older = _flat(_section(_read(KNOWN_LIMITS_MD), "Explanations of older records use today's settings"))
    assert "prices" not in older.split("A model call")[0]
    assert "shows its stored cost" in older
    assert "never repriced" in older


def test_the_sso_domain_sentence_reads_as_a_sentence():
    text = _flat(_read(AUTHENTICATION_MD))
    assert "An **Allowed domains**" not in text
    assert "**Allowed domains** checks the hosted domain" in text
