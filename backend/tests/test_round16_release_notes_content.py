"""Round 16 (SPEC §4.7 WP17): the What's new notes say what the code does.

The generator (``scripts/build_release_notes.py``) checks the notes' shape: plain text,
known Console pages, real permissions and public Help Center pages. It does not read
what a highlight claims. These checks read a code or record fact first and then the
notes, the way ``test_docs_round15_records.py`` checks the Help Center:

- every ``help`` link with an anchor lands on a heading of its page (the generator
  checks the page only, and the strict Help Center build does not fail on an anchor);
- the newest update names the tab each changed case shortcut now opens, from the tabs
  ``CaseDetail`` renders (SPEC D8: the welcome announces the Alt+2, Alt+4 and Alt+5
  changes and Chat on Alt+6);
- the 0.1.1 Case Manager line describes the Case Manager, and the other capabilities
  the 0.1 release record lists keep their own words.

Offline: reads repository files only.
"""

from __future__ import annotations

import json
import re
import unicodedata
from pathlib import Path

import app

REPO_ROOT = Path(app.__file__).resolve().parents[2]
DOCS = REPO_ROOT / "docs"
NOTES = DOCS / "releases" / "notes"
SOC = REPO_ROOT / "webui" / "src" / "soc"
CORPUS = REPO_ROOT / "backend" / "app" / "knowledge" / "app_docs.json"


def _notes() -> dict[str, dict]:
    return {path.stem: json.loads(path.read_text(encoding="utf-8")) for path in sorted(NOTES.glob("*.json"))}


def _highlights(release: dict):
    for update in release["updates"]:
        for item in update["highlights"]:
            yield update, item


def _highlight(release: dict, highlight_id: str) -> dict:
    found = [item for _update, item in _highlights(release) if item["id"] == highlight_id]
    assert len(found) == 1, highlight_id
    return found[0]


def _slug(heading: str) -> str:
    """Python-Markdown's default ``toc`` slug (the Help Center sets no other)."""
    text = re.sub(r"\s*\{[^}]*\}\s*$", "", heading)
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text).replace("`", "").replace("*", "")
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii")
    text = re.sub(r"[^\w\s-]", "", text).strip().lower()
    return re.sub(r"[-\s]+", "-", text)


def _anchors(page: str) -> set[str]:
    """The heading ids of one Help Center page: the knowledge corpus records the ids the
    Help Center's own ``toc`` gave each section; every heading's slug and explicit
    ``{#id}`` are added for a page the corpus does not hold."""
    corpus = json.loads(CORPUS.read_text(encoding="utf-8"))
    anchors = {chunk["anchor"] for chunk in corpus["chunks"] if chunk["page"] == page and chunk["anchor"]}
    in_fence = False
    for line in (DOCS / page).read_text(encoding="utf-8").splitlines():
        if line.lstrip().startswith(("```", "~~~")):
            in_fence = not in_fence
            continue
        match = None if in_fence else re.match(r"^#{1,6}\s+(.*?)\s*$", line)
        if match:
            anchors.add(_slug(match.group(1)))
            explicit = re.search(r"\{[^}]*#([\w-]+)[^}]*\}\s*$", match.group(1))
            if explicit:
                anchors.add(explicit.group(1))
    return anchors


def _page_for(help_path: str) -> str:
    stem = help_path.split("#", 1)[0].rstrip("/")
    for candidate in (f"{stem}.md", f"{stem}/index.md"):
        if (DOCS / candidate).is_file():
            return candidate
    raise AssertionError(f"{help_path}: no Help Center page")


def _case_tabs() -> list[tuple[str, str, str]]:
    """``(id, label, Alt key)`` per case tab, from the ``TabsTrigger`` elements of
    ``CaseDetail``, checked against ``CASE_TABS``."""
    match = re.search(r"export const CASE_TABS = \[([^\]]*)\]", (SOC / "case-tabs.ts").read_text(encoding="utf-8"))
    assert match is not None
    ids = re.findall(r"'([a-z]+)'", match.group(1))
    triggers = re.findall(
        r'<TabsTrigger value="([a-z]+)"[^>]*?aria-keyshortcuts="(Alt\+\d)"[^>]*>\s*([A-Za-z][A-Za-z ]*[A-Za-z])',
        (SOC / "pages" / "CaseDetail.tsx").read_text(encoding="utf-8"),
    )
    tabs = [(tab_id, label, key) for tab_id, key, label in triggers]
    assert [tab_id for tab_id, _label, _key in tabs] == ids
    return tabs


def test_every_help_anchor_is_a_heading_of_its_page():
    missing = []
    for version, release in _notes().items():
        for update, item in _highlights(release):
            help_path = item.get("help") or ""
            if "#" not in help_path:
                continue
            page = _page_for(help_path)
            anchor = help_path.split("#", 1)[1]
            if anchor not in _anchors(page):
                missing.append(f"{version} {update['id']} {item['id']}: {help_path}")
    assert missing == []


def test_the_newest_update_names_the_tab_each_changed_shortcut_opens():
    """SPEC D8: Alt+2, Alt+4 and Alt+5 changed meaning and Chat moved to Alt+6. The
    dialog shows only a highlight's summary, so the summary names the tabs those keys
    open now, read from the rendered tab triggers."""
    tabs = _case_tabs()
    assert len(tabs) == 6
    label = {key: tab_label for _id, tab_label, key in tabs}
    newest = _notes()["0.2.0"]["updates"][0]
    summary = next(item for item in newest["highlights"] if item["id"] == "case-tabs")["summary"]
    listed = ", ".join(tab_label for _id, tab_label, _key in tabs[:-1]) + " and " + tabs[-1][1]
    assert f"Six tabs: {listed}." in summary
    assert (
        f"Alt+2, Alt+4 and Alt+5 now open {label['Alt+2']}, {label['Alt+4']} and {label['Alt+5']}"
        in summary
    )
    assert f"{label['Alt+6']} moves to Alt+6" in summary


def test_the_011_case_manager_line_describes_only_the_case_manager():
    """The 0.1 release record lists campaigns, baselines, tuning, rules and custom
    dashboards beside the cases; the 0.1.1 notes keep them, but not as parts of the
    Case Manager."""
    record = " ".join((DOCS / "releases" / "0.1.md").read_text(encoding="utf-8").split())
    others = ("campaigns", "baselines", "tuning", "rules", "custom dashboards")
    for word in others:
        assert word in record
    release = _notes()["0.1.1"]
    manager = _highlight(release, "case-manager")
    assert manager["open"] == {"page": "case_manager"}
    assert not [word for word in others if word in manager["summary"].lower()]
    everything = " ".join(
        " ".join([item["summary"], *item.get("details", [])]) for _update, item in _highlights(release)
    ).lower()
    assert [word for word in others if word not in everything] == []
