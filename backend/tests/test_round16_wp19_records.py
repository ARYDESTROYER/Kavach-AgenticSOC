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
