"""Round 16 XFD: the docs and records follow-up after the cross-cutting review.

Each check reads the code fact first (a function, a constant, a Console string, a test
that exists), then the page or record that states it, so the record cannot drift from the
code again. Offline: it reads repository files and imports modules only.
"""

from __future__ import annotations

import re
from pathlib import Path

import app
from app.es.client import RealESClient
from app.es.indices import _MAPPING_METHODS

REPO_ROOT = Path(app.__file__).resolve().parents[2]
DOCS = REPO_ROOT / "docs"
WEBUI = REPO_ROOT / "webui" / "src"

AGENTS = REPO_ROOT / "AGENTS.md"
CHANGELOG = REPO_ROOT / "CHANGELOG.md"
DEMO_TOUR = REPO_ROOT / "DEMO.md"
DEPLOY = REPO_ROOT / "DEPLOY.md"
INSTALL = REPO_ROOT / "INSTALL.md"
README = REPO_ROOT / "README.md"
MKDOCS = REPO_ROOT / "mkdocs.yml"
USAGE = DOCS / "USAGE.md"
ROOT_TROUBLESHOOTING = DOCS / "TROUBLESHOOTING.md"
SPEC = DOCS / "research" / "2026-11-round16" / "SPEC.md"
UI_STANDARD = DOCS / "development" / "ui-standard.md"

API_MD = DOCS / "reference" / "api.md"
PERMISSIONS_MD = DOCS / "reference" / "permissions.md"
AUTHENTICATION_MD = DOCS / "administration" / "authentication.md"
AUDIT_LOG_MD = DOCS / "administration" / "audit-log.md"
UPGRADES_MD = DOCS / "operations" / "upgrades.md"
OPS_TROUBLESHOOTING_MD = DOCS / "operations" / "troubleshooting.md"
KPI_GLOSSARY_MD = DOCS / "analyst" / "kpi-glossary.md"
EXPLAINABLE_MD = DOCS / "analyst" / "explainable-numbers.md"
CASE_MANAGER_MD = DOCS / "analyst" / "case-manager.md"
FIRST_RUN_MD = DOCS / "getting-started" / "first-run.md"
INSTALL_MD = DOCS / "getting-started" / "install.md"
QUICKSTART_MD = DOCS / "getting-started" / "quickstart.md"
DEMO_MD = DOCS / "getting-started" / "demo.md"

RISK_PY = REPO_ROOT / "backend" / "app" / "engine" / "risk.py"
PROVIDERS_PY = REPO_ROOT / "backend" / "app" / "llm" / "providers.py"
ROUTES_PY = REPO_ROOT / "backend" / "app" / "api" / "routes.py"
CONFIG_PY = REPO_ROOT / "backend" / "app" / "config.py"
ROUTE_AUTH_TEST = REPO_ROOT / "backend" / "tests" / "test_route_auth_coverage.py"
RISK_TS = WEBUI / "lib" / "explain" / "risk.ts"
LOGIN_TSX = WEBUI / "soc" / "pages" / "Login.tsx"
REGISTRY_TSX = WEBUI / "soc" / "registry.tsx"
CASE_TABS_TS = WEBUI / "soc" / "case-tabs.ts"
CASE_HEADER_META_TSX = WEBUI / "soc" / "pages" / "casedetail" / "CaseHeaderMeta.tsx"
BUNDLE_TEST = WEBUI / "soc" / "__tests__" / "bundle-first-paint.test.ts"


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _flat(text: str) -> str:
    """Markdown with its line breaks folded, so a sentence reads as one string."""
    return re.sub(r"\s+", " ", text)


def _section(text: str, heading: str) -> str:
    """The body of one heading, up to the next heading of the same or a higher level."""
    match = re.search(rf"^(#+) {re.escape(heading)}\s*$", text, re.MULTILINE)
    assert match, f"no section {heading!r}"
    level = len(match.group(1))
    rest = text[match.end():]
    end = re.search(rf"^#{{1,{level}}} ", rest, re.MULTILINE)
    return rest[: end.start()] if end else rest


def _round16_changelog() -> str:
    text = _read(CHANGELOG)
    start = text.index("### Round 16")
    return text[start:text.index("### Round 15", start)]


# Part 1: the confirmed docs findings of the cross-cutting review.


def test_the_glossary_velocity_row_names_the_one_second_window_floor():
    # compute_risk raises a window under a second to 1 second; it never scores it 0.
    assert "max(cluster.window_seconds, 1.0)" in _read(RISK_PY)
    row = next(line for line in _read(KPI_GLOSSARY_MD).splitlines() if line.startswith("| Velocity |"))
    assert "sub-second window" not in row
    assert "1 second" in row
    assert "0 below three events" in row


def test_current_help_center_path_statements_name_the_running_docs_line():
    line = re.search(r'docs_version:\s*"([\d.]+)"', _read(MKDOCS)).group(1)
    statement = re.compile(
        r"(?:served by the Console at|Bundled with the Console at|bundled with this application at)"
        r"\W*/docs/([\d.]+)/"
    )
    for path in (README, INSTALL, INSTALL_MD, USAGE):
        found = statement.findall(_read(path))
        assert all(version == line for version in found), (path.name, found)
    # The README gallery caption and the install figure captions state the path.
    assert f"<code>/docs/{line}/</code>" in _read(README)
    assert f"served by the Console at /docs/{line}/" in _read(INSTALL_MD)


def test_screenshot_alt_text_claims_no_removed_layout():
    # The case page has no Investigation tab beside the Decision card since the six tabs,
    # and the Help Center is no longer served under /docs/0.1/.
    tabs = re.search(r"CASE_TABS = \[(.*?)\]", _read(CASE_TABS_TS)).group(1)
    assert "'evidence'" in tabs
    alts = []
    for path in (README, INSTALL, QUICKSTART_MD, INSTALL_MD, FIRST_RUN_MD):
        text = _read(path)
        alts += re.findall(r'alt="([^"]*)"', text)
        alts += re.findall(r"!\[([^\]]*)\]\([^)]*screenshots/", text)
    joined = " | ".join(alts)
    assert "open on its Investigation tab" not in joined
    assert "served under /docs/0.1/" not in joined
    assert "describes Agentic SOC 0.1.13" not in joined


def test_permissions_and_authentication_say_every_read_is_gated():
    # The GET coverage rule exists, so the docs may not say only writes are checked.
    assert "def test_read_routes_declare_authz" in _read(ROUTE_AUTH_TEST)
    permissions = _flat(_read(PERMISSIONS_MD))
    assert "Non-GET routes are expected to declare" not in permissions
    assert "every `/api` route, reads included" in permissions
    authentication = _flat(_read(AUTHENTICATION_MD))
    assert "state-changing routes add permission checks" not in authentication
    assert "reads as well as writes" in authentication


def test_the_upgrade_notes_say_bootstrap_applies_the_audit_upgrade_itself():
    # The shipped client can read a template and read and extend a mapping, so the
    # additive audit upgrade runs at every start and no warning repeats.
    assert all(callable(getattr(RealESClient, name, None)) for name in _MAPPING_METHODS)
    stale = (
        "cannot read or extend index mappings, so the backend",
        "keeps logging the reminder on every start",
        "logs a warning naming the step on every start",
        "Elasticsearch audit mapping (required step)",
        "Audit index on Elasticsearch (required step)",
    )
    for path in (UPGRADES_MD, DEPLOY, OPS_TROUBLESHOOTING_MD, ROOT_TROUBLESHOOTING):
        text = _flat(_read(path))
        for phrase in stale:
            assert phrase not in text, (path.name, phrase)
    upgrades = _flat(_read(UPGRADES_MD))
    assert "bootstrap applies it itself" in upgrades
    assert "could not be read" in upgrades


def test_the_demo_tour_names_the_communication_inbox():
    assert "{ id: 'notifications', label: 'Communication' }" in _read(REGISTRY_TSX)
    tour = _read(DEMO_TOUR)
    assert "*Notifications → Inbox*" not in tour
    assert "*Communication → Inbox*" in tour


def test_usage_names_branding_as_the_one_organization_theme_default():
    assert "def _one_org_theme_default" in _read(CONFIG_PY)
    usage = _flat(_read(USAGE))
    assert "overrides the org `default_theme`" not in usage
    assert "`default_saved_views`, `default_theme`)" not in usage
    assert "Branding's `default_theme`" in usage


def test_the_agents_layout_names_the_response_tab():
    assert "'runbook'" in _read(CASE_TABS_TS)
    agents = _flat(_read(AGENTS))
    assert "RunbookPanel (the Runbook tab" not in agents
    assert "RunbookPanel (the Response tab" in agents


def test_the_api_reference_names_both_routes_that_refuse_a_running_or_held_case():
    routes = _read(ROUTES_PY)
    start = routes.index('@router.post("/cases/{case_id}/investigate")')
    assert "open_case_conflict" in routes[start:start + 3000]
    runs = _flat(_section(_read(API_MD), "AI investigation runs"))
    assert "`POST /api/cases/{case_id}/investigate`" in runs


# Part 2: the records of the packages merged after the repository records.


def test_the_sign_in_page_sentences_in_the_records_are_the_console_ones():
    login = _read(LOGIN_TSX)
    sentences = (
        "The username or password is not correct.",
        "Could not reach the server. Try again.",
        "Too many attempts. Wait a few minutes, then try again.",
        "Use the organization default theme",
    )
    for sentence in sentences:
        assert sentence in login, sentence
    changelog = _flat(_round16_changelog())
    first_run = _flat(_read(FIRST_RUN_MD))
    for sentence in sentences:
        assert sentence in changelog, sentence
        assert sentence in first_run, sentence
    # The page no longer says the sign-in screens follow only the browser.
    assert "follow the browser's own choice" not in first_run


def test_the_copied_risk_calculation_has_the_console_velocity_step():
    # The Velocity step is written from the recorded count and window.
    assert "min(100, 100 x ${inputs.event_count} / (" in _read(RISK_TS)
    copy = _section(_read(EXPLAINABLE_MD), "Copy calculation")
    assert "- Velocity: min(100, 100 x 12 / (300 / 60) / 10) = 24" in copy
    assert "- Velocity: min(100, 100 x 2.4 / 10) = 24" not in copy


def test_the_demo_page_says_a_run_you_start_is_paced():
    # The suite's conftest sets the pause to 0, so read the shipped default from the source.
    delay = re.search(r"^DEMO_INVESTIGATION_STEP_DELAY_S = ([\d.]+)", _read(PROVIDERS_PY), re.MULTILINE)
    assert delay and float(delay.group(1)) > 0
    demo = _flat(_read(DEMO_MD))
    assert "pauses at each step" in demo
    assert "storyline" in demo


def test_the_header_strip_order_in_the_docs_is_the_console_one():
    meta = _read(CASE_HEADER_META_TSX)
    assert "owner: 'min-w-5 shrink-[1000000000000]'" in meta
    page = _flat(_read(CASE_MANAGER_MD))
    assert "the owner's name is shortened first, then the AI verdict's words" in page


def test_the_audit_log_page_says_spend_needs_cost_view():
    assert "cost:view" in _flat(_read(AUDIT_LOG_MD))
    assert "(amount hidden)" in _flat(_read(AUDIT_LOG_MD))


def test_agents_records_the_round16_entry_baseline():
    value = int(re.search(r"const PRE_REVAMP_ENTRY_BYTES = ([\d_]+);", _read(BUNDLE_TEST)).group(1).replace("_", ""))
    assert f"{value:,} B" in _read(AGENTS)


def test_the_spec_records_the_cross_cutting_review_and_its_fix_packages():
    spec = _read(SPEC)
    review = _flat(_section(spec, "8.5 Cross-cutting review"))
    for fact in ("50 findings", "46", "40 were confirmed", "6 were refuted"):
        assert fact in review, fact
    for package in ("XFB", "XFDEMO", "XFNUM", "XFSIGN", "XFCM", "XFD"):
        assert f"**{package}" in review, package
    for dimension in ("spine", "security", "numbers", "UI", "tests", "flows", "docs"):
        assert dimension in review, dimension
    assert _section(spec, "8.4 Verification record").strip() == "Written after the closing gates."
    limits = _flat(_section(spec, "8.3 Known limitations"))
    assert "taken by the post-integration package" not in limits
    resolutions = _flat(_section(spec, "8.1 Contract resolutions"))
    assert "second container restart" in resolutions
    per_package = _flat(_section(spec, "8.2 Per package"))
    for package in ("WP16P", "WP17A", "WP18B", "WP18C", "XFB", "XFDEMO", "XFNUM", "XFSIGN"):
        assert f"**{package}" in per_package, package


def test_the_spec_b09_lines_name_the_case_lock():
    spec = _flat(_read(SPEC))
    amendment = "`link_cross_source` re-reads each linked case under `pipeline.case_lock(case.case_id)`, taken alone"
    assert spec.count(amendment) >= 3, "section 2, section 4.4 and Appendix C C10"
    assert "`_reenter_detections` passes `trigger=\"detection\"` and `known_case_id`" in spec
    assert "carries `automation_actions`, `notifications_sent` and the three link fields" in spec


def test_ui_standard_states_the_fixed_sign_in_sentences_and_the_hover_fallback():
    standard = _flat(_read(UI_STANDARD))
    assert "Use the organization default theme" in standard
    assert "never renders the server's raw text" in standard
    assert "from the unrounded factors" in standard
