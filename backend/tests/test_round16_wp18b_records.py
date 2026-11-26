"""Round 16 WP18B: the repository records say what the code and the SPEC say.

Each check reads the code or the source document first, then the record. Offline: it
reads repository files only.
"""

from __future__ import annotations

import re
from pathlib import Path

import app
from app import whats_new

REPO_ROOT = Path(app.__file__).resolve().parents[2]
DOCS = REPO_ROOT / "docs"
AGENTS = REPO_ROOT / "AGENTS.md"
CHANGELOG = REPO_ROOT / "CHANGELOG.md"
DEMO = REPO_ROOT / "DEMO.md"
ROADMAP = REPO_ROOT / "ROADMAP.md"
HANDOFF = DOCS / "HANDOFF.md"
USAGE = DOCS / "USAGE.md"
ROUND14_SPEC = DOCS / "research" / "2026-10-round14" / "SPEC.md"
ROUND16_SPEC = DOCS / "research" / "2026-11-round16" / "SPEC.md"
REGISTRY = REPO_ROOT / "webui" / "src" / "soc" / "registry.tsx"


def _text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _flat(text: str) -> str:
    return re.sub(r"\s+", " ", text)


def _round16_changelog() -> str:
    text = _text(CHANGELOG)
    start = text.index("### Round 16")
    return text[start:text.index("### Round 15", start)]


def test_the_round14_accepted_defaults_table_is_one_table_with_its_amendment_after_it():
    """The dated D3 amendment must not split the D1 to D45 table: a paragraph between two
    rows ends the table, and the rows after it no longer render as a table."""
    spec = _text(ROUND14_SPEC)
    section = spec[spec.index("### 2.3 Accepted defaults"):spec.index("### 2.4 ")]
    lines = section.splitlines()
    first = next(i for i, line in enumerate(lines) if line.startswith("| D1 |"))
    last = next(i for i, line in enumerate(lines) if line.startswith("| D45 |"))
    rows = lines[first:last + 1]
    assert all(line.startswith("| D") for line in rows), [
        line for line in rows if not line.startswith("| D")]
    assert len(rows) == 45
    after = "\n".join(lines[last + 1:])
    assert "Amendment (2026-11-26, Round 16 SPEC D6" in after
    assert "D3 is reversed for the sign-in row" in _flat(after)


def test_the_records_say_a_new_account_starts_with_whats_new_marked_seen():
    """The code stamps the newest update id on every new account (SPEC D7), so no record
    may promise a new account the welcome."""
    assert "must not be welcomed" in (whats_new.__doc__ or "")
    assert callable(whats_new.stamp_new_account)
    changelog = _flat(_round16_changelog())
    assert "A new account starts with it marked seen" in changelog
    assert "once for a new account" not in changelog
    agents = _flat(_text(AGENTS))
    assert "welcome stamped on new accounts" not in agents
    assert "new accounts start with marked seen" in agents
    assert "new accounts start with it marked seen" in _flat(_text(HANDOFF))
    assert "a new account starts with it marked seen" in _flat(_text(USAGE))


def _usage_section(heading: str) -> str:
    usage = _text(USAGE)
    start = usage.index(f"\n{heading}\n") + 1
    rest = usage[start + len(heading):]
    ends = [m.start() for m in re.finditer(r"^(#{1,3} |---$)", rest, flags=re.M)]
    return usage[start:start + len(heading) + (ends[0] if ends else len(rest))]


def test_the_usage_inbox_routes_stay_under_the_inbox_heading():
    """The What's new section follows the whole In-app inbox section, so the Inbox route
    table and its notes are not filed under What's new."""
    inbox = _usage_section("### In-app inbox")
    for route in ("GET /api/notifications/inbox?unread_only=",
                  "POST /api/notifications/inbox/read-all",
                  "GET`/`PUT /api/notifications/prefs"):
        assert route in inbox, route
    assert "Accepted application jobs upsert one stable Inbox row" in _flat(inbox)
    whats_new_section = _usage_section("### What's new")
    assert "/api/notifications/inbox" not in whats_new_section
    assert "misc.whats_new_seen" in whats_new_section


def test_the_round16_changelog_intro_names_only_the_mapping_this_round_adds():
    """Round 16 adds one Elasticsearch mapping extension (the cases index); the audit and
    config extensions are Round 14's and Round 15's."""
    intro = _flat(_round16_changelog().split("#### Added", 1)[0])
    assert "three Elasticsearch mappings" not in intro
    assert "the cases mapping gains two properties additively" in intro


def test_the_round16_changelog_names_every_bug_id_of_appendix_a():
    spec = _text(ROUND16_SPEC)
    appendix = spec[spec.index("## Appendix A."):spec.index("## Appendix B.")]
    ids = sorted(set(re.findall(r"^\| (B\d\d) \|", appendix, flags=re.M)))
    assert len(ids) == 81
    section = _round16_changelog()
    missing = [bug for bug in ids if not re.search(rf"\b{bug}\b", section)]
    assert not missing, missing


def test_the_spec_entry_figure_for_the_sign_in_saving_matches_its_package_note():
    spec = _flat(_text(ROUND16_SPEC))
    package = re.search(r"The entry fell by ([0-9,]+ B)", spec)
    resolution = re.search(r"WP04 had freed ([^.]+?)\. ", spec)
    assert package and resolution
    assert resolution.group(1) == package.group(1)


def test_the_roadmap_no_longer_calls_0113_a_live_candidate():
    roadmap = _flat(_text(ROADMAP))
    assert "remains a candidate until every publication" not in roadmap
    assert "It was never tagged; the correction ships in 0.2.0" in roadmap


def test_the_demo_tour_names_the_intelligence_pages_the_navigation_shows():
    registry = _text(REGISTRY)
    start = registry.index("label: 'Intelligence'")
    block = registry[start:registry.index("/* ----", start)]
    children = re.findall(r"label: '([^']+)'", block)[1:]
    assert "Runbooks" in children
    demo = _text(DEMO)
    sentence = _flat(demo[demo.index("left-nav, which has its own"):demo.index("Point out")])
    for label in children:
        assert label in sentence, label
    assert "Playbooks" not in sentence
    assert "Communication** (Inbox and What's new" in sentence
