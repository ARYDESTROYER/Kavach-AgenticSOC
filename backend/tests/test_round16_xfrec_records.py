"""Round 16 XFREC: the records of every package merged after XFR, and the acceptance pass.

Each check reads the code fact first (a Console string, a function, a constant), then the
record that states it, so the record cannot drift from the code. Offline: it reads
repository files and imports modules only.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import app
from app.api.routes_triage import RUNBOOK_AI_KIND
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
    assert "- **A11Y, closing accessibility and phone sweep.** Recorded with the closing gates." in per_package
    assert "WP19 is recorded with the release preparation." in per_package
    assert "WP17B and WP19 are recorded with the closing gates." not in per_package

    acceptance = _flat(_section(spec, "8.6 Acceptance pass"))
    for fact in ("`9343312`", "Eight checkers", "66 gaps, 23 medium and 43 low", "One verdict ran",
                 "`decision-lane-raw-engine-record` was confirmed", "folded into the closing sweep",
                 "No package judged a gap not real", "acceptance/acceptance-pass.md"):
        assert fact in acceptance, fact
    for package in ("FXB", "FXA1", "FXA2", "FXC", "FXD1", "FXD2", "FXE", "WP17D"):
        assert package in acceptance, package
    assert _section(spec, "8.4 Verification record").strip() == "Written after the closing gates."


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
