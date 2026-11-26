"""Round 16 WP17D: a screenshot for every visible change on the release tracker.

Each check reads a code or file fact first (the lanes the Brief renders, the image header,
the notes) and then the record that relies on it. Offline: it reads repository files only.
"""

from __future__ import annotations

import hashlib
import json
import re
import struct
from pathlib import Path

import app

REPO_ROOT = Path(app.__file__).resolve().parents[2]
DOCS = REPO_ROOT / "docs"
NOTES = DOCS / "releases" / "notes" / "0.2.0.json"
ASSETS = DOCS / "assets" / "releases" / "0.2.0"
RECORD = DOCS / "research" / "2026-11-round16" / "acceptance" / "screenshots.md"
OVERVIEW_PANEL = REPO_ROOT / "webui" / "src" / "soc" / "pages" / "casedetail" / "OverviewPanel.tsx"
README = REPO_ROOT / "README.md"
QUICKSTART = DOCS / "getting-started" / "quickstart.md"
CASE_MANAGER_SHOT = DOCS / "assets" / "screenshots" / "case-manager.webp"

MAX_BYTES = 250_000
MAX_WIDTH = 2_880

# Highlights WP17D gave a light and a dark figure for the first time.
ADDED = (
    "team-activity", "case-screenshots", "auto-close-review", "close-case", "chat-starters",
    "chat-unlimited", "report-downloads", "workspace-chat", "reports", "kpi-drilldown",
    "cyber-defence-center", "human-vs-ai", "background-jobs", "noise-flow-views",
    "auto-closed-tile", "rule-sheets", "severity-levels", "docked-navigation", "chat-capacity",
    "chat-titles", "remember-me", "enrichment-providers", "data-export", "declared-benign",
    "account-activity", "required-mfa",
)

# Highlights that stay text only: no Console surface, a surface the seeded Demo cannot show,
# or a surface another figure already shows. The record gives the reason for each.
TEXT_ONLY = (
    "access-fixes", "fixes", "license", "super-admin-accounts", "keep-human-work",
    "architecture-diagrams", "fallback-guidance", "audit-control-characters", "rollback-safety",
    "permission-aware-console", "chat-reading", "chat-working", "exact-counts",
    "agent-health-bell", "navy-dark-mode", "ground-truth", "investigator-fields",
    "authenticator-qr", "precedent-promotion", "corpus-guard", "supervised-updates",
    "legacy-bootstrap",
)

# The sha256 of each image WP17D captured again (the files at 39335e5). The Console
# changed under each one; a byte-identical file still shows the old interface.
REPLACED = {
    "ai-working-dark.webp": "dbd479d375bc0069b6cd00c180b9efb63aa9efdf0600766821c87ff93c0e3666",
    "ai-working-light.webp": "46c69ef7bc6d6d15580cc904e698c8d42bead4abb50d14ba044944ba6daea024",
    "case-records-dark.webp": "d0277a13df7850d8aa6808a2bd00a357769e0eb5a0522f6e0005de6c2783f3b5",
    "case-records-light.webp": "4b3b74f432b8b822d90239a778eb9ba78ef07bac3fd31a5c4afc9af7d053f56c",
    "case-tabs-dark.webp": "dc9e829211acff0176da178fe02b012a28c8033eddf374d97eec038ae4120240",
    "case-tabs-light.webp": "a10ce11beaab7a1225d07ef70b9f3b85763af9d008fd57d9fbda015db46f3e5b",
    "case-workspace-dark.webp": "ff9f14606be121e7cba67dd74636350da9293aa65d52b020dfdffa7b7e73046e",
    "case-workspace-light.webp": "626b3e6d9ecb6f40e74f04ffd471a2ee01669eb949d25754a1b39b632ab86c0f",
    "explain-numbers-dark.webp": "7ee3d2cf84a32788875ea049c9de2760acd1371a5620759da7a16a030db1e52d",
    "explain-numbers-light.webp": "a3048fc2b7e2b7700a90699294eed1f19aeea5c55dcdbf4ad0b3ce0364f5d3e1",
    "sign-in-dark.webp": "0ff65e7449b6e13738492714f2c75be5fb7fe89f2fc0df0c3b77d3a47b4e73b3",
    "sign-in-light.webp": "8fab4be705c58e4f63c999e19098d3ce5bee7c128d5261ed1ca97f3e31dfac18",
    "whats-new-dark.webp": "593ae01d6ca1df2ee50cedde1d17373b70c6e3383f649f3b03826e7bc1b7bf3a",
    "whats-new-light.webp": "17ad2beede490b7b1d24eee11bf90de46f341c14499333a6e345865a4ea0d432",
}
# The pixel size each replaced image keeps (same name, same frame).
REPLACED_SIZE = {
    "ai-working": (1950, 882),
    "case-records": (2880, 1800),
    "case-tabs": (1950, 1322),
    "case-workspace": (2880, 1800),
    "explain-numbers": (1950, 1664),
    "sign-in": (1600, 900),
    "whats-new": (2880, 1800),
}
CASE_MANAGER_0_2_0_BEFORE = "093b778fafa1ed91bad195d1451af7f09c441473dd87738f28a0f1dfcd6f8667"

# The review's recaptures: the sha256 of each file as WP17D first committed it (2c147cc).
# chat-titles was cut through the first question at the right edge and through a list line
# at the bottom; case-manager.webp showed a queue of one row filtered by a search.
REVIEW_REPLACED = {
    ASSETS / "chat-titles-light.webp": "878e532e852d03af75a1ba5cd4057d76808bee5aa9f7bbd217af2a303bf2c147",
    ASSETS / "chat-titles-dark.webp": "2f451db6cea9b2b579cc62caa680eb6e1ba45a04fce24b843bbcb02025f03b4d",
    CASE_MANAGER_SHOT: "576f5190180025304a24c27ca254ae99ece096e6d6ec79c29439131adc917413",
}
# The question bubble ends 1,402 CSS pixels from the left of the 1,440 viewport and the crop
# starts after the 64-pixel rail, so a crop that holds the whole question is at least
# 2 x (1,402 - 64) = 2,676 device pixels wide.
CHAT_TITLES_MIN_WIDTH = 2 * (1402 - 64)


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _highlights() -> dict[str, dict]:
    notes = json.loads(_read(NOTES))
    return {item["id"]: item for update in notes["updates"] for item in update["highlights"]}


def _webp_size(data: bytes) -> tuple[int, int]:
    assert data[:4] == b"RIFF" and data[8:12] == b"WEBP", "not a WebP file"
    kind = data[12:16]
    if kind == b"VP8 ":
        width, height = struct.unpack("<HH", data[26:30])
        return width & 0x3FFF, height & 0x3FFF
    if kind == b"VP8L":
        bits = int.from_bytes(data[21:25], "little")
        return (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
    if kind == b"VP8X":
        return int.from_bytes(data[24:27], "little") + 1, int.from_bytes(data[27:30], "little") + 1
    raise AssertionError(f"unknown WebP chunk {kind!r}")


def _wp17d_section() -> str:
    text = _read(RECORD)
    match = re.search(r"^## WP17D\b.*?(?=^## (?!#)|\Z)", text, re.M | re.S)
    assert match, "screenshots.md has no WP17D section"
    return match.group(0)


def test_every_highlight_has_a_figure_or_a_recorded_reason():
    items = _highlights()
    assert set(TEXT_ONLY) <= set(items)
    missing = [hid for hid, item in items.items() if "screenshot" not in item and hid not in TEXT_ONLY]
    assert missing == []
    shown = [hid for hid in TEXT_ONLY if "screenshot" in items[hid]]
    assert shown == []
    section = _wp17d_section()
    unexplained = [hid for hid in TEXT_ONLY if f"`{hid}`" not in section]
    assert unexplained == []


def test_each_added_figure_is_a_themed_pair_within_the_limits():
    items = _highlights()
    for hid in ADDED + tuple(REPLACED_SIZE):
        shot = items[hid]["screenshot"]
        assert shot["light"] == f"{hid}-light.webp", hid
        assert shot["dark"] == f"{hid}-dark.webp", hid
        assert len(shot["alt"]) >= 40, hid
        # Every figure WP17D added has a caption; case-records keeps its alt text only.
        assert hid not in ADDED or shot.get("caption"), hid
        sizes = set()
        for name in (shot["light"], shot["dark"]):
            data = (ASSETS / name).read_bytes()
            assert len(data) <= MAX_BYTES, (name, len(data))
            size = _webp_size(data)
            assert size[0] <= MAX_WIDTH, (name, size)
            sizes.add(size)
        assert len(sizes) == 1, (hid, sizes)


def test_every_replaced_image_is_a_new_capture_of_the_same_frame():
    stale = []
    for name, old_sha in REPLACED.items():
        data = (ASSETS / name).read_bytes()
        stem = name.rsplit("-", 1)[0]
        assert _webp_size(data) == REPLACED_SIZE[stem], name
        if hashlib.sha256(data).hexdigest() == old_sha:
            stale.append(name)
    data = CASE_MANAGER_SHOT.read_bytes()
    assert _webp_size(data) == (2880, 1800)
    if hashlib.sha256(data).hexdigest() == CASE_MANAGER_0_2_0_BEFORE:
        stale.append(CASE_MANAGER_SHOT.name)
    assert stale == []


def _brief_lanes() -> list[str]:
    """The names of the Brief's lanes, in the order OverviewPanel renders them."""
    panel = _read(OVERVIEW_PANEL)
    names = re.findall(r'name="([A-Z][a-z]+)"', panel)
    assert names[:2] == ["Evidence", "Assessment"], names
    assert "People" in names
    return names


def test_the_case_tabs_alt_names_the_lanes_the_brief_renders():
    lanes = _brief_lanes()
    assert "Assessment" in lanes
    alt = _highlights()["case-tabs"]["screenshot"]["alt"]
    assert "Evidence, Assessment, Decision and People lanes" in alt
    assert "Evidence, AI, Decision" not in alt


def test_the_case_manager_alt_names_the_assessment_lane():
    assert "Assessment" in _brief_lanes()
    for page in (README, QUICKSTART):
        text = _read(page)
        alts = re.findall(r'alt="(Case Manager[^"]*)"', text) + re.findall(
            r"!\[(Case Manager[^\]]*)\]\([^)]*case-manager\.webp", text
        )
        assert alts, page.name
        for alt in alts:
            assert "the Assessment lane, labelled AI" in alt, (page.name, alt)
            assert "the AI lane, labelled AI" not in alt, (page.name, alt)


def test_the_record_lists_every_file_this_package_added_or_replaced():
    section = _wp17d_section()
    names = [f"{hid}-{theme}.webp" for hid in ADDED for theme in ("light", "dark")]
    names += list(REPLACED)
    names.append("case-manager.webp")
    unlisted = [name for name in names if f"`{name}`" not in section]
    assert unlisted == []


def test_the_review_recaptures_replace_the_cut_and_filtered_frames():
    stale = [path.name for path, old_sha in REVIEW_REPLACED.items()
             if hashlib.sha256(path.read_bytes()).hexdigest() == old_sha]
    assert stale == []
    sizes = {_webp_size((ASSETS / f"chat-titles-{theme}.webp").read_bytes()) for theme in ("light", "dark")}
    assert len(sizes) == 1, sizes
    ((width, _height),) = sizes
    assert width >= CHAT_TITLES_MIN_WIDTH, width
    assert _webp_size(CASE_MANAGER_SHOT.read_bytes()) == (2880, 1800)
    section = _wp17d_section()
    assert "All scope with no search" in section
    assert "and a search, so the open case" not in section


def test_the_data_export_alt_says_the_button_is_unavailable():
    alt = _highlights()["data-export"]["screenshot"]["alt"]
    assert "Build ZIP in background button is unavailable" in alt
    assert "is off" not in alt
