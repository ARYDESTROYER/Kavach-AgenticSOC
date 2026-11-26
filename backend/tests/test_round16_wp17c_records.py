"""Round 16 WP17C: the docs screenshots, the lean Help Center bundle and one Demo limit.

Each check reads the code or file fact first (the notes that reference an image, the
Login heading, the Demo decision source), then the page or folder that relies on it.
Offline: it reads repository files only.
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
SCREENSHOTS = DOCS / "assets" / "screenshots"

# The sha256 of each 0.1.13 capture the refresh replaced (the files at 817bb7f). Each
# shows a surface 0.2.0 changed: the navigation (the Communication group), the release
# badge, or a page Login.tsx draws (create admin, second factor, sign-in), which lost
# the gradient theme pill and the grid backdrop. A byte-identical file still shows the
# old interface.
REPLACED_0_1_13 = {
    "hero-overview-light.webp": "a9307cbc87d761f923adc33c8a9ca789010cf42dba700f8d020224d3733c128a",
    "hero-overview-dark.webp": "e80b9970b98f3c47afd1c2aa4af16898265b0b6e5b7e31d7255653cd94d4cfb7",
    "audit-log.webp": "34b7d16818eadba5fe114b7824524ee8ed5b8bfb300726e6c6d715f4f3da47e9",
    "dashboards-library.webp": "89403e4e8c57efd9be2810462dc106bedffe4317e5573e32fd6c330d65576d31",
    "help-center.webp": "7a15e3fba3cc42cd3d98c6e292e2f6a079fe1c2d6245bbb21a0cd95bf24fe7a3",
    "runbooks.webp": "a891db51b88c8d7f39a4eae83f03c3faae728ce0f412da909e11783aad81f9e9",
    "sources.webp": "cfb775df22c00769d196974a825f56f8642ad0eae849ceaa71bd92652ada250d",
    "settings-models.webp": "8127c5daec5e66dd62a6b322c45c1ab80f6af7fb85cb72b0d10f54a0949c968b",
    "users-rbac.webp": "e2835c1b8ba8ea949f927efa77fee9aaab2c4241ed03c1db25cd3e8414ee4ad0",
    "users-add-user.webp": "8dffbf8954b4a9aa9a5e33b8d50622f7d3c7703cc94a9d52b979a72653ce2364",
    "workspace-chat.webp": "f0590ce28fbc15286ebb5baecb9c8d349767ca51a60428fa9bc86e7dcb15ff57",
    "case-manager.webp": "f9b8444bddb8dbdc727355347f94345d921be523a1c2b32b36307710102aea7d",
    "install-01-create-admin.webp": "df43caf3a5eeb30389a58e0cefe70bac3507ee0c9eed62c13361cb0b3e3b0e33",
    "install-01b-secure-account.webp": "6684a464586cb36143922878fc83ecc0c06d3f54d7929d7ea3f907d8ba692097",
    "install-02a-sign-in-username.webp": "cc4eba695e65b3a6a57b5349d141d018d2fa5876e847388e1cb0a60fb86c5419",
    "install-02-sign-in.webp": "c895a85a2893576cce46e17a9a5b3dc1b9364dd65aff2a287c53ce3719eaadfd",
    "install-07-after-launch.webp": "45051465756401c9b21a890436b9b80666286aa4b4f8b286a2415cc61d8d06b9",
}

# A What's new update that reused a docs screenshot points at a copy made before the
# refresh, so it keeps showing the interface it describes (SPEC 4.7 WP17).
RELEASE_COPIES = {
    "install-create-admin.webp": "install-01-create-admin.webp",
    "calmer-case-manager.webp": "case-manager.webp",
    "rbac-switch.webp": "users-rbac.webp",
    "add-user.webp": "users-add-user.webp",
    "audit-log.webp": "audit-log.webp",
    "dashboards-library.webp": "dashboards-library.webp",
    "runbooks-library.webp": "runbooks.webp",
}


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _flat(path: Path) -> str:
    return " ".join(_read(path).split())


def _webp_size(data: bytes) -> tuple[int, int]:
    """The pixel size from a WebP file's first chunk (lossy, lossless or extended)."""
    assert data[:4] == b"RIFF" and data[8:12] == b"WEBP", "not a WebP file"
    kind = data[12:16]
    if kind == b"VP8 ":
        assert data[23:26] == b"\x9d\x01\x2a", "bad VP8 start code"
        width, height = struct.unpack("<HH", data[26:30])
        return width & 0x3FFF, height & 0x3FFF
    if kind == b"VP8L":
        bits = int.from_bytes(data[21:25], "little")
        return (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
    if kind == b"VP8X":
        return int.from_bytes(data[24:27], "little") + 1, int.from_bytes(data[27:30], "little") + 1
    raise AssertionError(f"unknown WebP chunk {kind!r}")


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


def test_every_refreshed_screenshot_is_a_new_capture_of_the_same_frame():
    # Same name, same 2880 by 1800 frame (1440 by 900 at device scale 2) and the
    # 250 KB cap, but not the 0.1.13 bytes.
    stale = []
    for name, old_sha in REPLACED_0_1_13.items():
        data = (SCREENSHOTS / name).read_bytes()
        assert _webp_size(data) == (2880, 1800), name
        assert len(data) <= 250_000, (name, len(data))
        if hashlib.sha256(data).hexdigest() == old_sha:
            stale.append(name)
    assert not stale, f"still the 0.1.13 capture: {stale}"


def test_the_notes_keep_the_capture_from_before_the_refresh():
    used = _notes_images()
    folder = RELEASE_ASSETS / "0.2.0"
    for copy, original in RELEASE_COPIES.items():
        assert copy in used, copy
        digest = hashlib.sha256((folder / copy).read_bytes()).hexdigest()
        assert digest == REPLACED_0_1_13[original], copy
