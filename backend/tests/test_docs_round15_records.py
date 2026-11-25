"""Round 15: the records describe the code that ships (cross-cutting docs review).

Round 15 changed the case workspace (five tabs, a new Overview and Investigation order,
a Review scope, one primary action), added a per-case review state route, the auto-close
review sample, Team activity and new settings blocks. The Help Center pages, the API
reference, the repository docs and AGENTS.md must name what the code does, so each check
below reads the code fact first and then the record. Offline: reads repository files and
imports modules only.

Round 16 (SPEC D8, WP02, WP03; WP18A) rebuilt the case workspace again: six tabs (Brief,
Evidence, AI investigation, Response, Activity, Chat) on Alt+1 to Alt+6, a compact header
with a meta strip, the case facts as a column or a side sheet, and the queue's ``[`` fold.
The workspace checks below now pin that layout, still reading the code first, and
``test_the_docs_name_the_six_case_tabs_in_the_code_order`` reads the tab order and its
Alt keys from the rendered triggers.
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
DEMO_TOUR = DOCS / "getting-started" / "demo.md"
CASES_MD = DOCS / "analyst" / "cases.md"
CASE_MANAGER_MD = DOCS / "analyst" / "case-manager.md"
INVESTIGATION_MD = DOCS / "analyst" / "investigation.md"
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


def _case_tabs() -> list[tuple[str, str, str]]:
    """The case tabs as CaseDetail renders them: ``(id, label, Alt key)``, in order.

    Read from the ``TabsTrigger`` elements, and checked against ``CASE_TABS`` (the one
    list the router and the page share), so a renamed or reordered tab moves the records.
    """
    match = re.search(r"export const CASE_TABS = \[([^\]]*)\]", _text(SOC / "case-tabs.ts"))
    assert match is not None
    ids = re.findall(r"'([a-z]+)'", match.group(1))
    triggers = re.findall(
        r'<TabsTrigger value="([a-z]+)"[^>]*?aria-keyshortcuts="(Alt\+\d)"[^>]*>\s*([A-Za-z][A-Za-z ]*[A-Za-z])',
        _text(PAGES / "CaseDetail.tsx"),
    )
    tabs = [(tab_id, label, key) for tab_id, key, label in triggers]
    assert [tab_id for tab_id, _label, _key in tabs] == ids
    assert [key for _id, _label, key in tabs] == [f"Alt+{n}" for n in range(1, len(ids) + 1)]
    return tabs


def _in_order(text: str, needles: list[str]) -> bool:
    """Every needle is in ``text``, each after the one before it."""
    at = -1
    for needle in needles:
        at = text.find(needle, at + 1)
        if at == -1:
            return False
    return True


def _prose(path: Path) -> str:
    """The flattened page as a reader sees it: without image alt text (it describes the
    captured image) and without Markdown emphasis or code marks, so a retired name written
    as ``**Runbook** tab`` reads as the "Runbook tab" it shows."""
    text = re.sub(r"!\[[^\]]*\]", "", _text(path))
    text = re.sub(r'alt="[^"]*"', "", text).replace("**", "").replace("`", "")
    return " ".join(text.split())


def test_the_quickstart_and_readme_give_the_ai_and_decision_order():
    """Round 16 moved the Decision into the Brief's lanes, after the AI lane, and left
    the AI investigation tab with nothing the code made (no Code tag)."""
    brief = _text(CASEDETAIL / "OverviewPanel.tsx")
    assert brief.index('name="AI"') < brief.index("name={decisionTitle(c)}")
    panel = _text(CASEDETAIL / "InvestigationPanel.tsx")
    assert 'title="AI assessment"' in panel
    assert 'kind="code"' not in panel and "decisionTitle" not in panel
    for page in (QUICKSTART, README):
        text = _flat(page)
        assert "above the advisory AI assessment" not in text, page.name
        assert "advisory AI assessment below gives" not in text, page.name
    quickstart = _flat(QUICKSTART)
    assert (
        "a case's Brief tab shows the **AI** lane, labelled **AI**, and then the **Decision** "
        "lane, labelled **Code**." in quickstart
    )
    assert "a case's Investigation tab shows" not in quickstart
    # Until the Case Manager screenshot is captured again, its alt text describes the
    # 0.1.13 layout; each page then says the image is from that version.
    if "open on its Investigation tab" in quickstart:
        assert "The screenshot below is from version 0.1.13" in quickstart
    readme = _flat(README)
    if "open on its Investigation tab" in readme:
        assert "All images are real captures of version 0.1.13" in readme


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


def test_usage_describes_the_case_workspace():
    """Round 15 pinned five tabs; Round 16 pins six, the header's rows and the case facts."""
    tabs = _case_tabs()
    assert len(tabs) == 6
    case_detail = _text(PAGES / "CaseDetail.tsx")
    usage = _flat(USAGE)
    assert "the same six tabs" in usage
    assert "renders **six tabs** (version 0.2)" in usage
    for stale in (
        "seven tabs",
        "the same five tabs",
        "**five tabs**",
        "Alt+1 to Alt+5",
        "facts rail",
        "**Share**",
        "Timeline and Investigation are already tabs",
        "The separate **Timeline** tab",
        "Overview defaults to inputs",
        "For an opened record, **Overview** conditionally adds",
        "a compact decision brief",
    ):
        assert stale not in usage, stale
    # The header (118px, the comment says) and the case facts' column toggle.
    assert "sticky header (118px" in case_detail
    assert 'aria-keyshortcuts="]"' in case_detail and "@[52rem]/case:block" in case_detail
    assert "Its header is 118 px tall for every case." in usage
    assert "**Case facts** (`]`)" in usage
    assert "a column once the case pane is 52rem wide" in usage
    assert "**Active / Mine / Review / All**" in usage
    for label in ("Take action", "More options"):
        assert label in case_detail, label
        assert f"**{label}**" in usage, label
    assert "`actions_taken`" in usage
    assert f"at most {CASE_ACTIONS_TAKEN_MAX} values" in usage
    assert '`review_via`: `"auto_close_review"`' in usage


def test_first_case_describes_the_brief_lanes():
    """Round 15: the Overview led with the AI's summary. Round 16: the Brief keeps the
    source, the AI, the code and the people apart in four tagged lanes."""
    brief = _text(CASEDETAIL / "OverviewPanel.tsx")
    for lane in ('name="Evidence"', 'name="AI"', "name={decisionTitle(c)}", 'name="People"'):
        assert lane in brief, lane
    assert "How this case was built" in brief
    assert "SOURCE SAYS" not in brief and "DECISION SUMMARY" not in brief
    assert "label: 'SIEM'" in _text(SOC / "components" / "ProvenanceTag.tsx")
    page = _flat(FIRST_CASE)
    assert "separates the decision brief and provenance" not in page
    assert "the Overview gives the AI's summary" not in page
    assert (
        "the Brief keeps the four apart in lanes: Evidence (tagged SIEM), the AI's summary "
        "(tagged AI), the deterministic Decision (tagged Code, with its policy inputs) and "
        "People." in page
    )
    assert "**How this case was built**" in page


def test_the_cases_page_names_the_bulk_exclusion():
    match = re.search(
        r"export const AGENT_CLOSED_LEFT_OUT = '([^']+)';", _text(CASEDETAIL / "queue.ts")
    )
    assert match is not None
    assert "AGENT_CLOSED_LEFT_OUT" in _text(PAGES / "Cases.tsx")
    assert match.group(1) in _flat(CASES_MD)


def test_the_collaboration_page_matches_the_tab():
    """Round 16: the Activity tab has three sections; the tasks moved to Response, which
    shows them to everyone (with the runbook for a viewer who may read runbooks)."""
    panel = _text(CASEDETAIL / "CollaborationPanel.tsx")
    titles = re.findall(r'<PanelSection\s+title="([^"]+)"', panel)
    assert titles == ["Discussion", "Files", "History"]
    assert "Show all activity" in panel
    assert "There is no owner picker here" in panel
    assert '<PanelSection title="Tasks" testId="response-tasks"' in _text(PAGES / "CaseDetail.tsx")
    assert "Other tasks" in _text(SOC / "components" / "CaseTasks.tsx")
    page = _text(COLLABORATION_MD)
    headings = re.findall(r"^## (.+)$", page, re.M)
    for title in titles:
        assert any(title.lower() in heading.lower() for heading in headings), title
    flat = _flat(COLLABORATION_MD)
    assert "A case's **Activity** tab keeps human coordination" in flat
    assert "in three sections: Discussion, Files and History." in flat
    assert "Discussion, Files, Tasks and History" not in flat
    response = next((label, key) for tab_id, label, key in _case_tabs() if tab_id == "runbook")
    assert f"Case tasks live on the **{response[0]}** tab ({response[1]}), under **Other tasks**" in flat
    assert "Open the Runbook tab" not in flat
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
    """The tab labels and keys come from the rendered triggers (Round 16: six tabs), and a
    retired tab's link lands on the tab its section is on now (Evidence)."""
    tabs = _case_tabs()
    order = "/".join(label for _id, label, _key in tabs)
    legacy = re.findall(r"^\s+(\w+): \['([a-z]+)', '[a-z-]+'\],$", _text(SOC / "case-tabs.ts"), re.M)
    assert {old for old, _new in legacy} == {"timeline", "threat"}
    assert {new for _old, new in legacy} == {"evidence"}
    landing = next(label for tab_id, label, _key in tabs if tab_id == "evidence")
    triage = _table_row(TESTING, "Triage")
    assert f"{order} tabs on Alt+1 to Alt+{len(tabs)}" in triage
    assert f"legacy `tab=timeline` or `tab=threat` link landing on its {landing} section" in triage
    assert "Timeline/" not in triage and "Threat context/" not in triage
    assert "Active/Mine/Review/All queue" in triage
    assert "the `[` queue fold" in triage and "its `]` toggle" in triage
    assert "Team activity" in _table_row(TESTING, "Intelligence and analytics")
    assert "Role-based access switch" in _table_row(TESTING, "Platform and help")
    assert "The case **Threat context** tab" not in _flat(MITRE_MD)
    assert f"The **Threat context** section of a case's {landing} tab" in _flat(MITRE_MD)


def test_the_docs_name_the_six_case_tabs_in_the_code_order():
    """Round 16 (WP18A): every record that lists the case tabs lists the six the page
    renders, in the order and on the Alt keys the code gives them, and no record names a
    retired tab or the facts rail as if it were still there."""
    tabs = _case_tabs()
    assert len(tabs) == 6
    labels = [label for _id, label, _key in tabs]
    listed = ", ".join(labels[:-1]) + " and " + labels[-1]

    # Case Manager: the tabs table (label and key per row, in order), the Alt sentence,
    # the shortcut row and the deep-link ids.
    manager = _text(CASE_MANAGER_MD)
    rows = [
        [cell.strip() for cell in line.split("|")[1:3]]
        for line in manager.splitlines()
        if re.match(r"^\| [A-Z][A-Za-z ]* \| Alt\+\d \|", line)
    ]
    assert rows == [[label, key] for _id, label, key in tabs]
    flat = _flat(CASE_MANAGER_MD)
    assert f"Alt+1 to Alt+{len(tabs)} open the case tabs in order: {listed}." in flat
    assert f"| Alt+1 to Alt+{len(tabs)} | Switch case tabs |" in manager
    assert _in_order(flat, ["`tab` is one of"] + [f"`{tab_id}`" for tab_id, _label, _key in tabs])

    # Cases: one bullet per tab, in order.
    assert (
        f"The canonical Case Manager detail has six tabs, one lane each, on Alt+1 to Alt+{len(tabs)}."
        in _section(CASES_MD, "Work a case")
    )
    work_a_case = _text(CASES_MD).split("\n## Work a case\n")[1].split("\n## ")[0]
    assert re.findall(r"^- \*\*([^*]+)\*\*:", work_a_case, re.M) == labels

    # USAGE: the case detail paragraph names each tab and its id in order.
    usage = _flat(USAGE)
    start = usage.index("`CaseDetail` renders **six tabs**")
    detail = usage[start:usage.index(f"Alt+1 to Alt+{len(tabs)} move between the tabs", start)]
    assert _in_order(detail, [f"**{label}**" for label in labels])
    assert _in_order(detail, [f"`{tab_id}`" for tab_id, _label, _key in tabs])

    # The short lists: README and the demo tour.
    assert f"{listed} tabs" in _flat(README)
    assert f"compare the {listed} tabs" in _flat(DEMO_TOUR)

    # No record still sends a reader to a retired tab or the facts rail.
    retired = ("Runbook tab", "Collaboration tab", "Investigation tab", "Overview tab",
               "facts rail", "five tabs", "Alt+1 to Alt+5")
    pages = (CASE_MANAGER_MD, CASES_MD, INVESTIGATION_MD, COLLABORATION_MD, FIRST_CASE,
             QUICKSTART, README, USAGE, DEMO_TOUR, MITRE_MD, TESTING,
             REPO_ROOT / "DEMO.md",
             DOCS / "intelligence" / "runbooks.md",
             DOCS / "automation" / "approvals.md",
             DOCS / "administration" / "audit-log.md",
             DOCS / "concepts" / "deterministic-decisions.md",
             PERMISSIONS)
    for page in pages:
        prose = _prose(page)
        for stale in retired:
            assert stale not in prose, (page.name, stale)


def _brief_lanes() -> dict[str, bool]:
    """The Brief's lanes as OverviewPanel renders them: lane name to whether it links to
    a tab (a ``links=`` prop). The Decision lane's name is computed (``decisionTitle``)."""
    brief = _text(CASEDETAIL / "OverviewPanel.tsx")
    body = brief[brief.index('<dl aria-label="Case brief"'):brief.index("</dl>")]
    lanes: dict[str, bool] = {}
    for chunk in re.split(r"<Lane\b(?!Link)", body)[1:]:
        named = re.search(r'name="([A-Za-z ]+)"|name=\{(decisionTitle)\(c\)\}', chunk)
        assert named is not None, chunk[:80]
        lanes["Decision" if named.group(2) else named.group(1)] = "links=" in chunk
    return lanes


def test_the_case_docs_match_the_brief_and_the_case_facts_code():
    """WP18A review: the docs describe what the Brief and the case facts do now.

    The decision card is folded under "Policy inputs" in the Decision lane (no longer
    pinned to a tab); the Decision lane has no tab link, unlike the other three; ``]``
    opens the case facts' side sheet in a narrow pane, as the header toggle does; and the
    investigation inputs live on the AI investigation tab, not on a case Overview."""
    lane = _text(CASEDETAIL / "DecisionLane.tsx")
    folded = lane.index("<LaneDisclosure open={inputsOpen}>Policy inputs</LaneDisclosure>")
    assert lane.index("<CollapsibleContent", folded) < lane.index("<DecisionCard", folded)
    for page in (USAGE, CASE_MANAGER_MD, CASES_MD, INVESTIGATION_MD, FIRST_CASE,
                 DOCS / "concepts" / "deterministic-decisions.md"):
        assert not re.search(r"pinned[^.]{0,40}decision ?card", _prose(page), re.IGNORECASE), page.name
    assert "the deterministic DecisionCard folded under Policy inputs" in _prose(USAGE)

    lanes = _brief_lanes()
    assert lanes == {"Evidence": True, "AI": True, "Decision": False, "People": True}
    linked = [name for name, links in lanes.items() if links]
    manager = _prose(CASE_MANAGER_MD)
    assert "linking to its tab" not in manager
    assert f"{', '.join(linked[:-1])} and {linked[-1]} link to the tabs that hold their detail" in manager

    case_detail = _text(PAGES / "CaseDetail.tsx")
    toggle = case_detail[case_detail.index("const toggleInspector = React.useCallback"):]
    toggle = toggle[:toggle.index("}, [setInspectorOpen]);")]
    assert "setDetailsOpen(true)" in toggle
    assert "toggleInspectorRef.current();" in case_detail[case_detail.index("if (event.key === ']')"):][:200]
    assert "In a narrower pane, Case facts (or ]) opens the same facts in a side sheet" in manager

    api = _prose(API)
    assert "Case Manager Overview project" not in api
    assert "the case's Investigation inputs (on its AI investigation tab) project the latest run" in api


def test_the_api_reference_states_the_agent_improvement_review_exclusions():
    source = _text(BACKEND_APP / "engine" / "agent_improvement.py")
    assert '"auto_close_review_grade"' in source
    assert "_review_reopen_times" in source
    section = _section(API, "Agent-improvement evidence")
    assert "`exclusions.auto_close_review_grade`" in section
    assert '`review_via: "auto_close_review"`' in section
