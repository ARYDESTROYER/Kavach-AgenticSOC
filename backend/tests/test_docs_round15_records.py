"""Round 15: the records describe the code that ships (cross-cutting docs review).

Round 15 changed the case workspace (five tabs, a new Overview and Investigation order,
a Review scope, one primary action), added a per-case review state route, the auto-close
review sample, Team activity and new settings blocks. The Help Center pages, the API
reference, the repository docs and AGENTS.md must name what the code does, so each check
below reads the code fact first and then the record. Offline: reads repository files and
imports modules only.
"""

from __future__ import annotations

import re
import typing
from pathlib import Path

import app
from app.api import routes_auto_close_review
from app.config import AutoCloseReviewConfig
from app.constants import CASE_ACTIONS_TAKEN_MAX
from app.engine import team_activity
from app.models import FeedbackEntry

REPO_ROOT = Path(app.__file__).resolve().parents[2]
DOCS = REPO_ROOT / "docs"
WEBUI = REPO_ROOT / "webui" / "src"
SOC = WEBUI / "soc"
PAGES = SOC / "pages"
CASEDETAIL = PAGES / "casedetail"
BACKEND_APP = REPO_ROOT / "backend" / "app"

README = REPO_ROOT / "README.md"
AGENTS = REPO_ROOT / "AGENTS.md"
CHANGELOG = REPO_ROOT / "CHANGELOG.md"
WEBUI_README = REPO_ROOT / "webui" / "README.md"
USAGE = DOCS / "USAGE.md"
HANDOFF = DOCS / "HANDOFF.md"
QUICKSTART = DOCS / "getting-started" / "quickstart.md"
FIRST_CASE = DOCS / "getting-started" / "first-case.md"
CASES_MD = DOCS / "analyst" / "cases.md"
COLLABORATION_MD = DOCS / "analyst" / "collaboration.md"
TEAM_ACTIVITY_MD = DOCS / "analyst" / "team-activity.md"
ANALYTICS_MD = DOCS / "analyst" / "analytics.md"
AUTOMATION_INDEX = DOCS / "automation" / "index.md"
AUTO_CLOSE_REVIEW_MD = DOCS / "automation" / "auto-close-review.md"
MITRE_MD = DOCS / "intelligence" / "mitre-threat-context.md"
API = DOCS / "reference" / "api.md"
PERMISSIONS = DOCS / "reference" / "permissions.md"
UI_STANDARD = DOCS / "development" / "ui-standard.md"
TESTING = DOCS / "development" / "testing.md"


def _text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _flat(path: Path) -> str:
    return " ".join(_text(path).split())


def _section(path: Path, heading: str) -> str:
    """The flattened body of one ``## heading`` section of a Markdown page."""
    text = _text(path)
    start = text.index(f"\n## {heading}\n")
    end = text.find("\n## ", start + 1)
    return " ".join(text[start:end if end != -1 else None].split())


def _table_row(path: Path, first_cell: str) -> str:
    return next(line for line in _text(path).splitlines() if line.startswith(f"| {first_cell} |"))


def test_the_quickstart_and_readme_give_the_investigation_tab_order():
    panel = _text(CASEDETAIL / "InvestigationPanel.tsx")
    assert panel.index('title="AI assessment"') < panel.index("title={decisionTitle}")
    for page in (QUICKSTART, README):
        text = _flat(page)
        assert "above the advisory AI assessment" not in text, page.name
        assert "advisory AI assessment below gives" not in text, page.name
        assert "the advisory AI assessment, labelled AI, gives" in text, page.name
    assert (
        "a case's Investigation tab shows the **AI assessment**, labelled **AI** and marked "
        "advisory, then the **Decision** card, labelled **Code**." in _flat(QUICKSTART)
    )


def test_the_case_review_state_route_is_in_the_records():
    routes = {
        (method, route.path)
        for route in routes_auto_close_review.router.routes
        for method in getattr(route, "methods", ())
    }
    assert ("GET", "/api/cases/{case_id}/review") in routes
    source = _text(BACKEND_APP / "api" / "routes_auto_close_review.py")
    handler = source[source.index('@router.get("/cases/{case_id}/review"'):]
    handler = handler[:handler.index("\n\n\n")]
    assert 'require_permission("cases", "read")' in handler
    assert '"case_not_found"' in handler
    assert '"review_ledger_unavailable"' in source

    model = routes_auto_close_review.CaseReviewState
    fields = "{" + ", ".join(model.model_fields) + "}"
    states = typing.get_args(model.model_fields["state"].annotation)
    assert states == ("none", "pending", "completed", "expired")

    assert "`GET /api/cases/{case_id}/review`" in _table_row(API, "Auto-close review")
    section = _section(API, "Auto-close review")
    assert "`GET /api/cases/{case_id}/review` (`cases:read`)" in section
    assert f"returns `{fields}`" in section
    for value in states:
        assert f"`{value}`" in section, value
    for code in ("`404 case_not_found`", "`503 review_ledger_unavailable`"):
        assert code in section, code

    assert "`GET` and `POST /api/cases/{id}/review`" in _flat(CHANGELOG)
    assert "`GET /api/cases/{id}/review`" in _flat(AGENTS)
    assert "| See one case's review state | `cases:read` |" in _text(PERMISSIONS)


def test_usage_describes_the_round15_case_workspace():
    tabs = re.search(r"export const CASE_TABS = \[([^\]]*)\]", _text(SOC / "case-tabs.ts"))
    assert tabs is not None
    assert len(re.findall(r"'[a-z]+'", tabs.group(1))) == 5
    case_detail = _text(PAGES / "CaseDetail.tsx")
    usage = _flat(USAGE)
    assert "the same five tabs" in usage
    for stale in (
        "seven tabs",
        "**Share**",
        "Timeline and Investigation are already tabs",
        "The separate **Timeline** tab",
        "Overview defaults to inputs",
        "For an opened record, **Overview** conditionally adds",
        "a compact decision brief",
    ):
        assert stale not in usage, stale
    assert "**Active / Mine / Review / All**" in usage
    for label in ("Take action", "More options"):
        assert label in case_detail, label
        assert f"**{label}**" in usage, label
    assert "`actions_taken`" in usage
    assert f"at most {CASE_ACTIONS_TAKEN_MAX} values" in usage
    assert '`review_via`: `"auto_close_review"`' in usage


def test_first_case_does_not_promise_an_overview_brief():
    overview = _text(CASEDETAIL / "OverviewPanel.tsx")
    assert 'title="Summary"' in overview
    assert "SOURCE SAYS" not in overview and "DECISION SUMMARY" not in overview
    page = _flat(FIRST_CASE)
    assert "separates the decision brief and provenance" not in page
    assert "the Overview gives the AI's summary (tagged AI)" in page


def test_the_cases_page_names_the_bulk_exclusion():
    match = re.search(
        r"export const AGENT_CLOSED_LEFT_OUT = '([^']+)';", _text(CASEDETAIL / "queue.ts")
    )
    assert match is not None
    assert "AGENT_CLOSED_LEFT_OUT" in _text(PAGES / "Cases.tsx")
    assert match.group(1) in _flat(CASES_MD)


def test_the_collaboration_page_matches_the_tab():
    panel = _text(CASEDETAIL / "CollaborationPanel.tsx")
    titles = re.findall(r'<PanelSection\s+title="([^"]+)"', panel)
    assert titles == ["Discussion", "Files", "Tasks", "History"]
    assert "Show all activity" in panel
    assert "There is no owner picker here" in panel
    page = _text(COLLABORATION_MD)
    headings = re.findall(r"^## (.+)$", page, re.M)
    for title in titles:
        assert any(title.lower() in heading.lower() for heading in headings), title
    flat = _flat(COLLABORATION_MD)
    assert "Discussion, Files, Tasks and History" in flat
    assert "**Show all activity**" in flat
    assert "case header" in flat
    assert "Assign a case to an analyst or team so the queue has a visible owner." not in flat


def test_the_ui_standard_records_the_review_headline_and_actions():
    outcome = _text(SOC / "components" / "outcome.ts")
    assert "'Review disagreed'" in outcome and "'Reviewed'" in outcome
    plan = _text(CASEDETAIL / "review" / "review-plan.ts")
    assert "START_REVIEW_LABEL = 'Start review'" in plan
    assert "REVIEW_MENU_LABEL = 'Review this auto-close'" in plan
    ui = _flat(UI_STANDARD)
    outcome_paragraph = ui[ui.index("**Case outcome.**"):ui.index("**Case header.**")]
    assert '"Reviewed: false positive"' in outcome_paragraph
    assert '"Review disagreed: true positive"' in outcome_paragraph
    assert "Ordinary feedback never becomes the headline." in outcome_paragraph
    header_paragraph = ui[ui.index("**Case header.**"):]
    assert "Start review" in header_paragraph
    assert '"Review this auto-close" in place of Set disposition' in header_paragraph


def test_the_review_page_names_the_review_scope_controls():
    case_manager = _text(PAGES / "CaseManager.tsx")
    assert "'Show completed reviews'" in case_manager
    assert "disagreed|expired" in _text(SOC / "router.tsx")
    page = _flat(AUTO_CLOSE_REVIEW_MD)
    assert "with links to completed, disagreed and expired reviews" not in page
    assert "**Show completed reviews**" in page
    assert "`#/case_manager?review=disagreed`" in page


def test_team_activity_does_not_claim_tag_changes_are_counted():
    assert not any("tag" in kind for kind in team_activity.ALL_KINDS)
    assert "case.tagged" not in team_activity.WORK_ACTIONS
    page = _flat(TEAM_ACTIVITY_MD)
    assert "assignments and tag changes made from the Console" not in page
    assert "Tag changes are not counted on this page." in page


def test_section_overviews_name_the_review_sample_and_team_activity():
    config = AutoCloseReviewConfig()
    assert config.enabled is True
    percent = f"{round(config.sample_rate * 100)}%"
    automation = _flat(AUTOMATION_INDEX)
    assert (
        f"a random review sample of automatic closes ({percent}, at most {config.daily_cap} "
        f"a day and {config.per_rule_daily_cap} per rule)" in automation
    )
    assert "[Auto-close review](auto-close-review.md)" in automation
    assert "{ id: 'team', label: 'Team activity'" in _text(SOC / "registry.tsx")
    analytics = _flat(ANALYTICS_MD)
    assert "**Team activity** (`#/team`, `team:view`)" in analytics
    assert "[Team activity](team-activity.md)" in analytics


def test_the_webui_readme_does_not_promise_a_live_mock_runtime():
    assert '"ai_runtime_ready"' in _text(BACKEND_APP / "api" / "routes.py")
    readme = _flat(WEBUI_README)
    assert "live investigations use the mock runtime" not in readme
    assert "`ai_runtime_ready`" in readme
    assert "the AI agent investigates nothing" in readme


def test_agents_names_the_round15_scope_settings_and_feedback_fields():
    assert "value: 'review' as const" in _text(PAGES / "CaseManager.tsx")
    assert {"origin", "review_id"} <= set(FeedbackEntry.model_fields)
    agents = _flat(AGENTS)
    assert "Active/All split-pane" not in agents
    assert "Active/Mine/Review/All split-pane queue" in agents
    assert "`team_activity` (TeamActivityConfig" in agents
    assert "`auto_close_review` (AutoCloseReviewConfig" in agents
    assert "`FeedbackEntry.origin`/`review_id`" in agents
    handoff = _flat(HANDOFF)
    assert "Active/All split-pane" not in handoff
    assert "Share/Take Action" not in handoff
    assert "Active/Mine/Review/All split-pane queue" in handoff


def test_the_release_browser_checklist_names_the_round15_surfaces():
    labels = {"overview": "Overview", "runbook": "Runbook", "investigation": "Investigation",
              "collab": "Collaboration", "chat": "Chat"}
    tabs = re.search(r"export const CASE_TABS = \[([^\]]*)\]", _text(SOC / "case-tabs.ts"))
    assert tabs is not None
    order = "/".join(labels[tab] for tab in re.findall(r"'([a-z]+)'", tabs.group(1)))
    triage = _table_row(TESTING, "Triage")
    assert f"{order} tabs" in triage
    assert "Timeline/" not in triage and "Threat context/" not in triage
    assert "Active/Mine/Review/All queue" in triage
    assert "Team activity" in _table_row(TESTING, "Intelligence and analytics")
    assert "Role-based access switch" in _table_row(TESTING, "Platform and help")
    assert "The case **Threat context** tab" not in _flat(MITRE_MD)


def test_the_api_reference_states_the_agent_improvement_review_exclusions():
    source = _text(BACKEND_APP / "engine" / "agent_improvement.py")
    assert '"auto_close_review_grade"' in source
    assert "_review_reopen_times" in source
    section = _section(API, "Agent-improvement evidence")
    assert "`exclusions.auto_close_review_grade`" in section
    assert '`review_via: "auto_close_review"`' in section
