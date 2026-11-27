"""Round 16 XFREC: the records of every package merged after XFR, and the acceptance pass.

Each check reads the code fact first (a Console string, a function, a constant), then the
record that states it, so the record cannot drift from the code. Offline: it reads
repository files and imports modules only.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
from pathlib import Path

import pytest

import app
from app.agents.chat_tools.app_help import AppHelpTool
from app.agents.chat_tools.base import ChatToolContext
from app.api.routes_triage import RUNBOOK_AI_KIND
from app.config import Preferences
from app.knowledge import console_grant_pairs
from app.engine.case_cluster import window_words
from app.utils import relative_to_millis, now_utc, to_millis

REPO_ROOT = Path(app.__file__).resolve().parents[2]
DOCS = REPO_ROOT / "docs"
WEBUI = REPO_ROOT / "webui" / "src"

AGENTS = REPO_ROOT / "AGENTS.md"
CHANGELOG = REPO_ROOT / "CHANGELOG.md"
HANDOFF = DOCS / "HANDOFF.md"
SPEC = DOCS / "research" / "2026-11-round16" / "SPEC.md"
ACCEPTANCE = DOCS / "research" / "2026-11-round16" / "acceptance"
KNOWN_LIMITS = DOCS / "releases" / "known-limitations.md"
EXPLAINABLE_MD = DOCS / "analyst" / "explainable-numbers.md"
INVESTIGATION_MD = DOCS / "analyst" / "investigation.md"
CASE_MANAGER_MD = DOCS / "analyst" / "case-manager.md"
MODELS_PY = REPO_ROOT / "backend" / "app" / "models.py"

AI_RUN_TEXT_TS = WEBUI / "soc" / "investigations" / "aiRunText.ts"
AI_RUN_CHIP_TSX = WEBUI / "soc" / "investigations" / "AiRunChip.tsx"
REMEMBER_TSX = WEBUI / "soc" / "components" / "auth" / "RememberMeControls.tsx"
APP_SHELL_TSX = WEBUI / "soc" / "AppShell.tsx"
LOGIN_TSX = WEBUI / "soc" / "pages" / "Login.tsx"
MFA_CARD_TSX = WEBUI / "soc" / "components" / "MfaSetupCard.tsx"
REGISTRY_TSX = WEBUI / "soc" / "registry.tsx"
SHIFT_WIDGET_TSX = WEBUI / "soc" / "dashboard" / "widgets" / "shift.tsx"
RUN_DEMO_SH = REPO_ROOT / "scripts" / "run-demo.sh"
ACTIVITY_TEXT_TS = WEBUI / "soc" / "components" / "caseActivityText.ts"
TRACE_TSX = WEBUI / "soc" / "components" / "TraceTimeline.tsx"
OVERVIEW_PANEL_TSX = WEBUI / "soc" / "pages" / "casedetail" / "OverviewPanel.tsx"
DECISION_TS = WEBUI / "lib" / "explain" / "decision.ts"


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _flat(text: str) -> str:
    return " ".join(text.split())


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


def test_the_row_name_records_follow_ai_run_accessible_text() -> None:
    code = _read(AI_RUN_TEXT_TS)
    assert "export function aiRunAccessibleText(view: InvestigationView | null): string | null" in code
    assert "`AI investigation ${view.state === 'running' ? 'running' : 'waiting'}`" in code
    spec = _flat(_read(SPEC))
    assert "aiRunAccessibleText(view: InvestigationView | null) => string | null" in spec
    assert "started 40 seconds ago\" (from" not in spec
    assert "now)` appended to the row's accessible name" not in spec
    changelog = _flat(_round16_changelog())
    assert 'ends "AI investigation running" or "AI investigation waiting", with no elapsed time' in changelog


def test_the_phone_chip_records_say_the_word_ai() -> None:
    assert "const visible = compact ? 'AI' :" in _read(AI_RUN_CHIP_TSX)
    changelog = _flat(_round16_changelog())
    assert 'On a phone it shows the ring with the word "AI" and no clock' in changelog
    assert "ring alone" not in changelog
    spec = _flat(_read(SPEC))
    assert 'below a 30rem strip the header chip shows its mark with the word "AI"' in spec


def test_the_remember_me_records_state_no_duration() -> None:
    code = _read(REMEMBER_TSX)
    assert "Stay signed in on this device?" in code
    assert not re.search(r"\b\d+\s*(hours?|minutes?|days?)\b", code.split("title={", 1)[1].split("</ConfirmDialog>", 1)[0])
    changelog = _flat(_round16_changelog())
    assert 'asks "Stay signed in on this device?"' in changelog
    assert "states how long you stay signed in" not in changelog
    spec = _flat(_read(SPEC))
    assert "*Amendment (2026-11-26, FXC, §8.6):* at the operator's ask, the warning dialog states no duration" in spec


def test_the_sign_out_record_follows_the_account_menu() -> None:
    shell = _read(APP_SHELL_TSX)
    assert "Sign out" in shell and "Log out" not in shell
    assert 'The account menu says "Sign out"' in _flat(_round16_changelog())


def test_the_decision_wording_records_follow_decision_words() -> None:
    code = _read(ACTIVITY_TEXT_TS)
    sentence = re.search(r"const SENT_TO_ANALYST = '([^']+)';", code).group(1)
    assert sentence == "Sent to an analyst by the case policy."
    changelog = _flat(_round16_changelog())
    assert sentence in changelog
    assert "(Evidence, Assessment, Decision and People)" in changelog
    assert "(Evidence, AI, Decision and People)" not in changelog
    # The WP16P line about a lower-case verdict in the close note is no longer true (FXB).
    assert "writes the new verdict in lower case" not in changelog


def test_the_trace_records_name_the_runbook_actor_and_filter() -> None:
    assert RUNBOOK_AI_KIND == "runbook_ai"
    assert "runbook_ai" in _read(MODELS_PY).split("class TraceSpan", 1)[1].split("kind: str", 1)[0]
    trace = _read(TRACE_TSX)
    assert "{ value: 'runbook', label: 'Runbook' }" in trace
    assert "All, Agent, Tool, Code, People, Chat and Runbook" in _flat(_read(INVESTIGATION_MD))
    assert "All, Agent, Tool, Code, People, Chat or Runbook" in _flat(_read(CASE_MANAGER_MD))


def test_the_people_lane_note_is_in_the_help_center() -> None:
    note = "The AI investigation then replaced the close."
    assert note in _read(OVERVIEW_PANEL_TSX)
    assert note in _flat(_read(CASE_MANAGER_MD))


def test_the_confidence_source_is_in_the_help_center() -> None:
    source = re.search(r"export const CONFIDENCE_SOURCE = '([^']+)';", _read(DECISION_TS)).group(1)
    assert source.lower() in _flat(_read(EXPLAINABLE_MD)).lower()


def test_the_month_lookback_limit_holds_and_is_recorded() -> None:
    """While an upper-case M still reads as minutes, the limit is written down. If this fails
    because the parser learned months, take the limit out of SPEC 8.3 and the Help Center."""
    now = now_utc()
    assert to_millis(now) - relative_to_millis("now-1M", now) == 60_000
    assert window_words("now-1M") == "in the last month"
    assert "now-1M" in _flat(_read(KNOWN_LIMITS))
    assert "**Months in a lookback.**" in _read(SPEC)


def test_the_spec_records_every_package_after_xfr_and_the_acceptance_pass() -> None:
    spec = _read(SPEC)
    per_package = _flat(_section(spec, "8.2 Per package"))
    commits = {
        "XFR": ("50e15ea", "f078539"),
        "XFINT": ("6f110eb", "51628b7"),
        "WP16X": ("5318fa2", "326cd29"),
        "XFUI2": ("be6f00b", "f910caa"),
        "WP17B": ("1058f85",),
        "XFUI3": ("5d8e1a7", "5d835f1"),
        "WP17C": ("2a4637a", "b8aa699"),
        "FXB": ("4072720", "01d1ddb"),
        "FXA1": ("ef74ad6", "59198e8"),
        "FXC": ("c83cc6f", "d7aa6d4"),
        "FXA2": ("faafdd6", "5e405fc", "45b4829"),
        "FXD2": ("931b036", "6d2e7e8"),
        "FXE": ("f03c999", "4bc214d"),
        "FXD1": ("dd3c81f", "e95ed6d"),
        "FXF": ("b6d223f", "eb068ea"),
        "WP17D": ("2c147cc", "0707b0a"),
    }
    for package, shas in commits.items():
        start = per_package.index(f"- **{package},")
        line = per_package[start:per_package.index("- **", start + 4)]
        for sha in shas:
            assert f"`{sha}`" in line, (package, sha)
    assert "318,008 B" in per_package[per_package.index("- **FXF,"):]
    # The closing records wrote the A11Y line with its build and review commits.
    a11y = per_package[per_package.index("- **A11Y, closing accessibility and phone sweep**"):]
    for sha in ("a34c056", "5e5fb08"):
        assert f"`{sha}`" in a11y, sha
    assert "Recorded with the closing gates." not in per_package
    assert "WP19 is recorded with the release preparation." in per_package
    assert "WP17B and WP19 are recorded with the closing gates." not in per_package

    acceptance = _flat(_section(spec, "8.6 Acceptance pass"))
    for fact in ("`9343312`", "Eight checkers", "66 gaps, 23 medium and 43 low", "One verdict ran",
                 "`decision-lane-raw-engine-record` was confirmed", "folded into the closing sweep",
                 "No package judged a gap not real", "acceptance/acceptance-pass.md"):
        assert fact in acceptance, fact
    for package in ("FXB", "FXA1", "FXA2", "FXC", "FXD1", "FXD2", "FXE", "WP17D"):
        assert package in acceptance, package
    assert "Written after the closing gates." not in _section(spec, "8.4 Verification record")


def test_the_acceptance_record_counts_match_the_checkers() -> None:
    record = _read(ACCEPTANCE / "acceptance-pass.md")
    rows = re.findall(r"^\| [^|]+ \| partly \| (\d+) \| (\d+) \| (\d+) \|$", record, re.MULTILINE)
    assert len(rows) == 7
    assert sum(int(gaps) for gaps, _, _ in rows) == 66
    assert all(int(gaps) == int(med) + int(low) for gaps, med, low in rows)
    went = re.findall(r"^\| [^|]+ \| (FX[A-F]\d?|WP17D) \|$", record, re.MULTILINE)
    assert len(went) == 66
    checks = _read(ACCEPTANCE / "wp16-browser-checks.md")
    assert "**Fixed after this receipt.** XFUI2" in checks
    assert "bar 6" in checks


def test_agents_and_handoff_name_the_acceptance_pass() -> None:
    assert "acceptance/acceptance-pass.md" in _flat(_read(AGENTS))
    assert "an acceptance pass of every operator ask" in _flat(_read(HANDOFF))


def test_the_release_tracker_figure_count_in_the_changelog_matches_the_notes() -> None:
    notes = json.loads(_read(DOCS / "releases" / "notes" / "0.2.0.json"))
    highlights = [h for update in notes["updates"] for h in update["highlights"]]
    shots = sum(1 for h in highlights if h.get("screenshot"))
    assert f"{shots} of the {len(highlights)} highlights of 0.2.0 have a screenshot" in _flat(_round16_changelog())


# --------------------------------------------------------------------------- #
# XFREC review: each record below was checked against the code it names, and the
# check is kept, so the record cannot drift from it again.
# --------------------------------------------------------------------------- #
def test_the_changelog_names_entity_investigation_as_the_console_does() -> None:
    """The navigation names the page Entity investigation, so the release notes do too,
    never "the Investigate page"."""
    assert "label: 'Entity investigation'" in _read(REGISTRY_TSX)
    changelog = _flat(_round16_changelog())
    assert "Investigate page" not in changelog
    assert "Opening a case or Investigate no" not in changelog
    assert "Run investigation on Entity investigation) gets a toast" in changelog


def _super_admin_context() -> ChatToolContext:
    from app.rbac.policy import can

    grants = frozenset(pair for pair in console_grant_pairs() if can("super_admin", *pair))
    return ChatToolContext(prefs=Preferences(), grants=grants, app_version=app.__version__)


async def test_every_export_question_the_changelog_names_reaches_jobs_first() -> None:
    """Each question the CHANGELOG says chat's product help sends to Analytics → Jobs has
    the Jobs page as its first destination. "Abort the export" was named too, but it
    cites Settings › Data export first in a near tie, so it is not claimed."""
    changelog = _flat(_round16_changelog())
    match = re.search(r"Chat's product help sends (.+?) to Analytics → Jobs", changelog)
    assert match, "the CHANGELOG no longer names the questions sent to Analytics → Jobs"
    questions = re.findall(r'"([^"]+)"', match.group(1))
    assert questions
    for question in questions:
        outcome = await AppHelpTool().run(_super_admin_context(), query=question)
        assert outcome.ok and outcome.console_links, question
        assert outcome.console_links[0] == "page:batchjobs", (question, outcome.console_links)


def test_the_sign_in_phone_target_record_matches_the_setup_card() -> None:
    """The sign-in record names the phone targets FXC raised to 44 px. While the required
    two-factor setup's Copy and Download buttons stay 32 px, the CHANGELOG does not say
    every phone target is 44 px and the Help Center lists them as a limit; once they are
    raised, the limit goes."""
    assert "inline-flex h-11 w-11 items-center justify-center rounded-full" in _read(LOGIN_TSX)
    changelog = _flat(_round16_changelog())
    assert "the appearance buttons and the password reveal button are at least 44 px tall" in changelog
    assert "Every phone target is at least 44 px tall" not in changelog
    small = 'className="h-8 gap-1.5"' in _read(MFA_CARD_TSX)
    limits = _flat(_read(KNOWN_LIMITS))
    if small:
        assert "the Copy, Copy all and Download buttons are smaller than 44 px on a phone" in limits
    else:
        assert "Copy, Copy all and Download buttons are smaller than 44 px" not in limits, (
            "the setup card's buttons were raised: take the limit out of known-limitations.md "
            "and SPEC 8.3")


def test_the_sla_widget_record_says_where_its_link_goes() -> None:
    """The SLA widget's empty state links to the Standup, which lists the open breaches;
    there is no case filter for SLA breaches, so the record does not promise one."""
    assert "label: 'View the open breaches', page: 'standup'" in _read(SHIFT_WIDGET_TSX)
    changelog = _flat(_round16_changelog())
    assert "View the open breaches opens the Standup, which lists them." in changelog
    assert "past their response target, with a link to them" not in changelog


def test_the_demo_banner_prints_the_zero_dollar_mock_literally() -> None:
    """The run-demo.sh banner is an unquoted heredoc, so a bare "$0" printed the script's
    own name ("forced ./scripts/run-demo.sh mock LLM"). It is escaped and prints "$0"."""
    bash = shutil.which("bash")
    if bash is None:
        pytest.skip("bash is not installed")
    match = re.search(r"^cat <<BANNER\n.*?^BANNER$", _read(RUN_DEMO_SH), re.MULTILINE | re.DOTALL)
    assert match, "run-demo.sh has no BANNER heredoc"
    env = {
        "PATH": "/usr/bin:/bin", "DEMO_BIND_HOST": "127.0.0.1", "WEBUI_PORT": "5173",
        "BACKEND_PORT": "8088", "ADMIN_USER": "Admin", "ADMIN_PASS": "demo", "DEMO_MODE": "seeded",
        "TLSOC_VERSION": "0.2.0", "TLSOC_RELEASE_CHANNEL": "Testing", "SOURCE_BRANCH": "Testing",
    }
    banner = subprocess.run(
        [bash, "-c", match.group(0), "./scripts/run-demo.sh"],
        capture_output=True, text=True, env=env, timeout=30, check=True,
    ).stdout
    assert "(forced $0 mock LLM)" in banner, banner
    assert "run-demo.sh mock LLM" not in banner


# --------------------------------------------------------------------------- #
# Closing records review: the A11Y records say what its receipt and its code say.
# --------------------------------------------------------------------------- #
CASE_USAGE_TSX = WEBUI / "soc" / "pages" / "casedetail" / "records" / "CaseUsageButton.tsx"
THEME_CSS = WEBUI / "styles" / "theme.css"
UI_STANDARD_MD = DOCS / "development" / "ui-standard.md"


def test_the_a11y_records_count_findings_and_name_what_they_changed() -> None:
    """The receipt counts one run per rule, surface, theme and width, so A11Y's six serious
    findings are more than six runs: SPEC 8.6 counts findings, and the top bar one was found
    while capturing a fix, not by the after sweep's scrolled pass. The material rule and the
    review's fixes in WP12's Metrics.tsx and in MitreHeatmap.tsx sit outside their owners, so
    the A11Y line names them as deviations, as every later package line does. The AI calls
    list opens in a popover from the investigation cost, so the CHANGELOG does not call it a
    sheet. ui-standard.md names the material's re-point that theme.css makes."""
    receipt = _flat(_read(ACCEPTANCE / "a11y-closing-sweep.md"))
    assert "each run is one rule on one surface" in receipt
    assert "found while capturing finding 1" in receipt
    spec = _read(SPEC)
    acceptance = _flat(_section(spec, "8.6 Acceptance pass"))
    assert "It fixed all six serious findings" in acceptance
    assert "found while capturing a fix" in acceptance
    assert "serious runs it found" not in acceptance
    assert "one in the scrolled pass" not in acceptance
    assert "A11Y runs the closing sweep" not in acceptance
    per_package = _flat(_section(spec, "8.2 Per package"))
    start = per_package.index("- **A11Y, closing accessibility and phone sweep**")
    a11y = per_package[start:per_package.index("WP19 is recorded", start)]
    deviations = a11y[a11y.index("Deviations:"):]
    for name in ("scrolled pass", "`theme.css`", "`Metrics.tsx`", "`MitreHeatmap.tsx`"):
        assert name in deviations, name
    assert "from '@/ui/popover'" in _read(CASE_USAGE_TSX)
    changelog = _flat(_round16_changelog())
    assert "usage sheet" not in changelog
    assert "When a case's investigation cost opens its AI calls" in changelog
    theme = _read(THEME_CSS)
    rule = theme[theme.index(".glass-surface,\n  .material-surface {"):]
    assert "--warning-text: var(--panel-warning-text);" in rule[: rule.index("}")]
    standard = _flat(_read(UI_STANDARD_MD))
    assert ("On a material the semantic tints (`--<axis>-text`) resolve to the grouped panel's "
            "stronger inks (`--panel-<axis>-text`) in `theme.css`") in standard


def test_the_closing_baselines_agree_with_the_verification_record():
    """SPEC 8.4 holds the closing gate figures; AGENTS.md and testing.md repeat them, and the
    entry figures follow the baseline in bundle-first-paint.test.ts."""
    record = _flat(_section(_read(SPEC), "8.4 Verification record"))
    for fact in ("14,038", "14,009 passed, 29 skipped and 0 failed", "27 PostgreSQL-only",
                 "786 files, 9,955 passed, 19 skipped", "3,622 modules", "318,008 B",
                 "317,962 + 1,024 B", "0 errors, 0 warnings", "byte-identical to `3cfd5c0`"):
        assert fact in record, fact
    bundle = _read(WEBUI / "soc" / "__tests__" / "bundle-first-paint.test.ts")
    assert "const PRE_REVAMP_ENTRY_BYTES = 317_962;" in bundle
    agents = _flat(_read(AGENTS))
    assert "Current baseline (2026-11-26, Round 16 closing gates, Round 16 SPEC §8.4)" in agents
    for fact in ("14,043 pytest", "9,955 Vitest", "786 files", "317,962 B"):
        assert fact in agents, fact
    testing = _flat(_read(DOCS / "development" / "testing.md"))
    assert "14,043 backend tests" in testing and "9,955 Console tests" in testing
    # The review fixes ran the backend gates again; the record says so.
    assert "14,072 tests, 14,043 passed, 29 skipped and 0 failed" in record
    assert "recorded after its closing gates" not in testing
    assert "recorded after its closing gates" not in agents
