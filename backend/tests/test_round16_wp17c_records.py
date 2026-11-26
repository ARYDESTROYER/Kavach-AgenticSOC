"""Round 16 WP17C: the docs screenshots, the lean Help Center bundle and one Demo limit.

Each check reads the code or file fact first (the notes that reference an image, the
Login heading, the Demo decision source), then the page or folder that relies on it.
Offline: it reads repository files only.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import app

REPO_ROOT = Path(app.__file__).resolve().parents[2]
DOCS = REPO_ROOT / "docs"
WEBUI = REPO_ROOT / "webui" / "src"

README = REPO_ROOT / "README.md"
INSTALL = REPO_ROOT / "INSTALL.md"
FIRST_RUN_MD = DOCS / "getting-started" / "first-run.md"
QUICKSTART_MD = DOCS / "getting-started" / "quickstart.md"
DEMO_MD = DOCS / "getting-started" / "demo.md"
NOTES_DIR = DOCS / "releases" / "notes"
RELEASE_ASSETS = DOCS / "assets" / "releases"
ACCEPTANCE = DOCS / "research" / "2026-11-round16" / "acceptance"
LOGIN_TSX = WEBUI / "soc" / "pages" / "Login.tsx"
CASE_DETAIL_TSX = WEBUI / "soc" / "pages" / "CaseDetail.tsx"
STATE_PY = REPO_ROOT / "backend" / "app" / "state.py"

SCREENSHOT_PAGES = (README, INSTALL, FIRST_RUN_MD, QUICKSTART_MD)


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _flat(path: Path) -> str:
    return " ".join(_read(path).split())


def _notes_images() -> set[str]:
    """Every image name a What's new notes file uses, without its folder."""
    names: set[str] = set()
    for notes in NOTES_DIR.glob("*.json"):
        for value in re.findall(r'"([^"]+\.webp)"', _read(notes)):
            names.add(value.rsplit("/", 1)[-1])
    return names


def test_every_release_image_in_the_help_center_is_used_by_the_notes():
    # docs/assets/ ships in the Help Center bundle and so in the Console image; a
    # review capture belongs under research/, which mkdocs.yml leaves out.
    used = _notes_images()
    assert used, "the notes reference no image"
    shipped = sorted(p.name for p in RELEASE_ASSETS.rglob("*") if p.is_file())
    unused = [name for name in shipped if name not in used]
    assert not unused, unused
    assert "research/" in _read(REPO_ROOT / "mkdocs.yml")


def test_the_review_captures_live_beside_their_record():
    record = _read(ACCEPTANCE / "screenshots.md")
    folder = ACCEPTANCE / "screenshots"
    named = sorted(set(re.findall(r"`screenshots/([a-z0-9-]+\.webp)`", record)))
    assert len(named) == 60, len(named)
    for name in named:
        assert (folder / name).is_file(), name
        assert not (RELEASE_ASSETS / "0.2.0" / name).exists(), name
    on_disk = sorted(p.name for p in folder.glob("*.webp"))
    assert on_disk == named


def test_no_screenshot_page_dates_its_images_to_0_1_13():
    # The docs screenshots were captured again for 0.2.0, so no page may say they show
    # version 0.1.13 or the layout before the six tabs.
    for page in SCREENSHOT_PAGES:
        text = _flat(page)
        sentences = re.split(r"(?<=[.!?])\s+", text)
        dated = [s for s in sentences if "0.1.13" in s and re.search(r"screenshot|capture", s, re.I)]
        assert not dated, (page.name, dated)
        assert "shared one tab" not in text, page.name


def test_the_sign_in_alt_text_names_the_heading_the_login_page_shows():
    # A device that remembers nobody greets with "Sign in to {wordmark}"; the capture is
    # from a signed-out browser, so the alt text names that heading, not "Welcome back".
    login = _read(LOGIN_TSX)
    assert "rememberedUser ? 'Welcome back' : `Sign in to ${wordmark}`" in login
    for page in (INSTALL, FIRST_RUN_MD):
        text = _read(page)
        alts = re.findall(r"!\[([^\]]*)\]\([^)]*install-02a-sign-in-username\.webp", text)
        assert alts, page.name
        for alt in alts:
            assert "Sign in to Agentic SOC" in alt, (page.name, alt)
            assert "Welcome back" not in alt, (page.name, alt)
    # Continue is always shown on the username step.
    assert "Continue is always there" in login
    assert "Appears once a username is typed" not in _read(INSTALL)


def test_the_case_manager_alt_text_describes_the_brief_lanes():
    for page in (README, QUICKSTART_MD):
        text = _read(page)
        alts = re.findall(r'alt="([^"]*)"[^>]*>', text) if page == README else []
        alts += re.findall(r"!\[([^\]]*)\]\([^)]*case-manager\.webp", text)
        case_alts = [a for a in alts if a.startswith("Case Manager")]
        assert case_alts, page.name
        for alt in case_alts:
            assert "Brief tab" in alt, (page.name, alt)
            assert "Decision lane, labelled Code" in alt, (page.name, alt)


def test_the_demo_page_states_the_decision_lane_limit():
    # The lane reads the settings a person saved; Demo Mode decides with its sandbox copy.
    detail = _read(CASE_DETAIL_TSX)
    assert "api\n      .getSettings()" in detail or ".getSettings()" in detail
    assert "policyForVerdict(autoClosePolicy" in detail
    state = _read(STATE_PY)
    assert "return self._demo._demo_prefs() if self._demo is not None else self.prefs" in state
    demo = _flat(DEMO_MD)
    assert "Known limitation: in Demo Mode, a change to the auto-close policy in **Settings**" in demo
    assert "the Demo keeps deciding with its own policy" in demo


def test_the_notes_json_is_valid_and_references_only_shipped_images():
    for notes in NOTES_DIR.glob("*.json"):
        json.loads(_read(notes))
    shipped = {p.name for p in RELEASE_ASSETS.rglob("*.webp")}
    shared = {p.name for p in (DOCS / "assets" / "screenshots").glob("*.webp")}
    for name in _notes_images():
        assert name in shipped or name in shared, name
