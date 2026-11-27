"""WP19, the frozen release preparation for 0.2.0: the records it writes stay coherent.

These read the release records only. ``scripts/check_version.py`` already refuses a
release ref whose ``[Unreleased]`` section still holds notes or whose What's new notes
are not released and dated; these tests hold what it cannot see: the 0.1.13 correction
described once, the release page budget and markers, and the measured migration and
rollback evidence written the same way wherever it is recorded.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
CHANGELOG = REPO_ROOT / "CHANGELOG.md"
NOTES = REPO_ROOT / "docs" / "releases" / "notes" / "0.2.0.json"
RELEASE_PAGE = REPO_ROOT / "docs" / "releases" / "0.2.0.md"
LIMITATIONS = REPO_ROOT / "docs" / "releases" / "known-limitations.md"
UPGRADES = REPO_ROOT / "docs" / "operations" / "upgrades.md"
RELEASE_WORKFLOW = REPO_ROOT / ".github" / "workflows" / "release.yml"
PLAN_BUILDER = REPO_ROOT / "scripts" / "build_upgrade_plan.py"

SNAPSHOT_HEADING = (
    "## Development snapshot - 2026-08-05 - 0.1.13 Testing candidate "
    "(never tagged; folded into 0.2.0)"
)
#: The update ids of 0.2.0 as published; an update id never changes.
UPDATE_IDS = [
    "0.2.0.2026-12",
    "0.2.0.2026-11-25",
    "0.2.0.2026-11-13",
    "0.2.0.2026-11-11",
    "0.2.0.2026-11-06",
    "0.2.0.2026-10-24",
    "0.2.0.2026-10-12",
    "0.2.0.2026-10-09",
    "0.2.0.2026-09-09",
    "0.2.0.2026-08-24",
    "0.2.0.2026-08-22",
    "0.2.0.2026-08-05",
]
#: The release body the workflow publishes is this marker plus the page (check_version).
COMMIT_MARKER = "<!-- agentic-soc-release-commit:" + "0" * 40 + " -->\n\n"
#: The page budget of the release preparation (SPEC WP19), well under GitHub's limit.
RELEASE_PAGE_BUDGET = 60_000


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _flat(text: str) -> str:
    return " ".join(text.split())


def _heading_date() -> str:
    match = re.search(r"^## \[0\.2\.0\] - (\d{4}-\d{2}-\d{2})$", _read(CHANGELOG), re.MULTILINE)
    assert match, "CHANGELOG.md has no dated [0.2.0] heading"
    return match.group(1)


def _release_section() -> str:
    text = _read(CHANGELOG)
    start = re.search(r"^## \[0\.2\.0\] - ", text, re.MULTILINE).start()
    end = re.search(r"^## ", text[start + 3:], re.MULTILINE).start() + start + 3
    return text[start:end]


def test_the_0_1_13_correction_is_described_once_inside_the_release_section() -> None:
    text = _read(CHANGELOG)
    assert text.count("## [0.2.0] - ") == 1
    assert "Testing candidate for the 0.2 line, not yet tagged" not in text
    section = _release_section()
    assert section.count("### Legacy bootstrap correction") == 1
    assert text.count("### Legacy bootstrap correction") == 1
    assert text.count("normalizes an absent state-schema label on both installed") == 1
    assert "normalizes an absent state-schema label on both installed" in section
    snapshot = text.index(SNAPSHOT_HEADING) + len(SNAPSHOT_HEADING)
    body = text[snapshot:text.index("\n## ", snapshot)].strip()
    assert body == "Folded into [0.2.0]; see Legacy bootstrap correction."


def test_the_release_section_opens_with_its_summary() -> None:
    section = _release_section()
    summary = section.split("\n\n", 2)[1]
    flat = _flat(summary)
    assert "### " not in summary
    for phrase in (
        "AGENTIC_SOC_UPDATE_REPOSITORY=ARYDESTROYER/Kavach-AgenticSOC",
        "widens `audit.id` to `bigint`",
        "410 runbooks_moved",
        "409 rbac_switch_moved",
        "Rollback boundary",
        "Apache-2.0",
    ):
        assert phrase in flat, phrase
    # The correction's boundary now names what 0.2.0 itself changes.
    legacy = section[section.index("### Legacy bootstrap correction"):]
    assert "Sigstore identity/issuer change" not in legacy
    assert "Version 0.1.13 must repeat" not in legacy
    assert "`ARYDESTROYER/Kavach-AgenticSOC`" in legacy


def test_the_notes_are_released_on_the_heading_date_with_their_ids_unchanged() -> None:
    notes = json.loads(_read(NOTES))
    date = _heading_date()
    assert notes["status"] == "released"
    assert notes["date"] == date
    assert [u["id"] for u in notes["updates"]] == UPDATE_IDS
    assert notes["updates"][0]["date"] == date
    assert all(u["date"] for u in notes["updates"])


def test_the_release_page_fits_its_budget_and_carries_the_contract_markers() -> None:
    page = _read(RELEASE_PAGE)
    assert len(COMMIT_MARKER + page) < RELEASE_PAGE_BUDGET
    for marker in (
        "# Agentic SOC 0.2.0",
        "annotated tag `v0.2.0`",
        "Exact Stable build identity",
        "Immutable annotated-tag checklist",
        "TLSOC_RELEASE_CHANNEL=stable",
        "TLSOC_BUILD_SHA",
        "TLSOC_BUILD_DATE",
    ):
        assert marker in page, marker
    # A GitHub Release body breaks relative images; screenshots live on What's new.
    assert "![" not in page and "<img" not in page
    flat = _flat(page)
    assert f"The intended tag date is **{_heading_date()}**" in flat
    assert "re-dates the CHANGELOG heading and the notes before the tag is created" in flat
    assert "Testing candidate for the 0.2 line" not in flat
    assert "writes the full release notes on this page before the tag" not in flat


def test_the_measured_widening_is_written_the_same_way_and_keeps_the_timeout() -> None:
    rows = (
        "| 1,000,000 | 0.61 GB | 4.9 s and 4.1 s (two runs) |",
        "| 5,000,000 | 3.06 GB | 25.0 s |",
        "| 10,000,000 | 6.12 GB | 44.3 s |",
    )
    page, upgrades = _read(RELEASE_PAGE), _read(UPGRADES)
    for row in rows:
        assert row in page and row in upgrades, row
    limitations = _flat(_read(LIMITATIONS))
    assert "10 million (6.12 GB) 44 seconds" in limitations
    for text in (page, upgrades, _read(LIMITATIONS)):
        assert "measured at release preparation and recorded" not in text
        assert "The time per million rows is measured at release preparation." not in _flat(text)
    # 10 million rows took well under the 200 s line, so the plan keeps its 300 s.
    assert 'parser.add_argument("--backend-timeout", type=int, default=300)' in _read(PLAN_BUILDER)
    assert "--backend-timeout" not in _read(RELEASE_WORKFLOW)
    assert "keeps its 300-second backend rollout timeout" in _flat(page)


def test_the_v0_1_1_rollback_rehearsal_is_recorded_and_the_image_rehearsal_stays_open() -> None:
    limitations = _read(LIMITATIONS)
    assert "Recorded at release preparation." not in limitations
    section = limitations[limitations.index("### Rolling back to v0.1.1 resets the settings it does not model"):]
    section = section[: section.index("\n### ", 10)]
    flat = _flat(section)
    for name in ("analyst_rule_policies", "auto_close_review", "chat_agent", "team_activity"):
        assert f"`{name}`" in flat, name
    assert "maintainer action M5" in flat
    page = _flat(_read(RELEASE_PAGE))
    assert "--previous-release ba179651a7b63d6352ad346fd633e1460f3a4d39" in page
    assert "The image-level rehearsal on a Docker host stays maintainer action M5" in page
    upgrades = _flat(_read(UPGRADES))
    assert "is recorded at release preparation, in" not in upgrades
    assert "#rolling-back-to-v011-resets-the-settings-it-does-not-model" in upgrades


def test_the_summary_rollback_boundary_names_the_v0_1_1_settings_reset() -> None:
    """The rehearsal's one real loss on the canonical rollback target is in the summary."""
    flat = _flat(_release_section().split("\n\n", 2)[1])
    boundary = flat[flat.index("Rollback boundary"):]
    assert "v0.1.1" in boundary
    assert "every setting it does not model" in boundary


def test_the_release_page_explains_the_skipped_tests_as_they_are() -> None:
    """The 2 audit skips are the SQL run of Elasticsearch-only tests; no CI lane runs them."""
    flat = _flat(_read(RELEASE_PAGE))
    assert "Elasticsearch-only tests, which run in their CI lanes" not in flat
    assert "27 PostgreSQL-only tests, which run in the PostgreSQL lane" in flat
    assert "point-in-time snapshots" in flat


#: Help Center pages, the research records excluded.
HELP_CENTER_PAGES = sorted(
    p for p in (REPO_ROOT / "docs").rglob("*.md") if "research" not in p.relative_to(REPO_ROOT / "docs").parts
)
DEFAULT_MAIN_CLAIM = re.compile(r"default `main`|`main` as (?:the|its) default|\(the default branch\)")


def test_no_help_center_page_says_main_is_already_the_default_branch() -> None:
    """The default branch is a repository setting (M1); one note records its real state."""
    claims = [
        str(page.relative_to(REPO_ROOT))
        for page in HELP_CENTER_PAGES
        if DEFAULT_MAIN_CLAIM.search(_flat(_read(page)))
    ]
    assert claims == []
    channels = _flat(_read(REPO_ROOT / "docs" / "releases" / "channels.md"))
    assert "On 2026-11-27 the default was still `Testing`" in channels


def test_the_large_table_pre_step_stops_the_backend_first() -> None:
    """A manual ALTER against a running backend breaks its cached statements (CHANGELOG)."""
    upgrades = _read(UPGRADES)
    section = upgrades[upgrades.index("### The audit id column"):upgrades.index("### Rolling back from 0.2.0")]
    pre_step = _flat(section[section.index("On a very large audit table"):section.index("```sql")])
    assert "stop the backend" in pre_step
    assert "with the backend stopped" in _flat(_read(RELEASE_PAGE))


ACCEPTANCE = REPO_ROOT / "docs" / "research" / "2026-11-round16" / "acceptance"
SPEC = REPO_ROOT / "docs" / "research" / "2026-11-round16" / "SPEC.md"


def test_the_receipts_and_the_spec_line_record_the_release_preparation() -> None:
    postgres = _flat(_read(ACCEPTANCE / "release-postgres-receipt.md"))
    for fact in ("PostgreSQL 16.15", "| 10,000,000 | 6,115,549,184 B (6.12 GB) |", "44.3 s",
                 "37 of 38", "32 of 33", "maintainer action M5"):
        assert fact in postgres, fact
    browser = _flat(_read(ACCEPTANCE / "release-browser-receipt.md"))
    for fact in ("SHA 963cec4335aebaa3362273de6bbb87eafbf90ea5", "v0.2.0 · Stable",
                 "568 loads", "19 checks, 19 pass", "vite preview over webui/dist (not nginx)"):
        assert fact in browser, fact
    spec = _read(SPEC)
    assert "WP19 is recorded with the release preparation." not in spec
    per_package = spec[spec.index("### 8.2 Per package"):spec.index("### 8.3 Known limitations")]
    line = _flat(per_package[per_package.index("- **WP19, the frozen release preparation**"):])
    for fact in ("`963cec4`", "2026-11-27", "M5", "release-postgres-receipt.md",
                 "release-browser-receipt.md"):
        assert fact in line, fact
    record = spec[spec.index("### 8.4 Verification record"):spec.index("### 8.5 Cross-cutting review")]
    assert "The release preparation WP19 (`963cec4`" in record


def test_the_review_pass_names_the_build_it_ran_on() -> None:
    """The review changed the Help Center, so its pass ran on its own stamped build."""
    browser = _read(ACCEPTANCE / "release-browser-receipt.md")
    review = _flat(browser[browser.index("## Review pass"):])
    for fact in ("SHA f6a1fe52cdf797d7325ffbdf4f6a3309a3f7c51f", "19 checks, 19 pass",
                 "Create your admin account", "the sweep above was not repeated"):
        assert fact in review, fact
    # The first-run setup is no longer listed as never opened.
    not_covered = _flat(browser[browser.index("## Not covered here"):browser.index("## Result")])
    assert "**First-run setup on an empty backend**" not in not_covered
    spec = _read(SPEC)
    per_package = spec[spec.index("### 8.2 Per package"):spec.index("### 8.3 Known limitations")]
    line = _flat(per_package[per_package.index("- **WP19, the frozen release preparation**"):])
    assert "reviewed in `f6a1fe5`" in line and "its review follows" not in line
    record = spec[spec.index("### 8.4 Verification record"):spec.index("### 8.5 Cross-cutting review")]
    assert "The WP19 review (`f6a1fe5`" in record
