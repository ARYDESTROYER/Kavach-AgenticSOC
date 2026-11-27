"""Round 16 XFUI3: the Help Center leftovers of the XFINT review.

- The analyst guide's Analytics page names every page the Analytics navigation group
  opens, read from the Console registry, with its route (it named four of seven).
- The release procedure names the GitHub Pages setting as a GitHub one, never as a bold
  arrow path the knowledge builder reads as a Console breadcrumb (it warned about
  ``**Settings → Pages → Source**``).

The cancel aliases and their destinations are covered in ``test_app_knowledge.py``.
"""
from __future__ import annotations

import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
DOCS = REPO_ROOT / "docs"
REGISTRY_TSX = REPO_ROOT / "webui" / "src" / "soc" / "registry.tsx"
ANALYTICS_MD = DOCS / "analyst" / "analytics.md"
CHANNELS_MD = DOCS / "releases" / "channels.md"
BUILD_APP_KNOWLEDGE = REPO_ROOT / "scripts" / "build_app_knowledge.py"


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _flat(text: str) -> str:
    return " ".join(text.split())


def _analytics_pages() -> list[tuple[str, str]]:
    """``[(id, label)]`` of the Analytics navigation group's children, in order."""
    source = _read(REGISTRY_TSX)
    start = source.index("id: 'analytics',")
    block = source[source.index("children: [", start):]
    block = block[: block.index("\n    ],")]
    pages = re.findall(r"id: '([a-z_]+)',\s*label: '([^']+)'", block)
    assert len(pages) >= 7, pages
    return pages


def _intro(markdown: str) -> str:
    """The page's text before its first second-level heading."""
    body = markdown.split("\n---\n", 1)[-1]
    return body.split("\n## ", 1)[0]


def test_the_analytics_intro_names_every_page_the_group_opens():
    intro = _flat(_intro(_read(ANALYTICS_MD)))
    assert "opens seven pages" in intro
    for page_id, label in _analytics_pages():
        assert f"**{label}** (`#/{page_id}`" in intro, (page_id, label)
    # The pages the XFINT review found missing.
    for label in ("Models", "Baseline", "Jobs"):
        assert f"**{label}**" in intro
    # The Round 15 record still holds.
    assert "**Team activity** (`#/team`, `team:view`)" in intro


def test_the_analytics_intro_lists_the_pages_in_navigation_order():
    intro = _flat(_intro(_read(ANALYTICS_MD)))
    positions = [intro.index(f"**{label}** (`#/{page_id}`") for page_id, label in _analytics_pages()]
    assert positions == sorted(positions)


def _section(markdown: str, heading: str) -> str:
    start = markdown.index(f"\n## {heading}\n")
    rest = markdown[start + 1:]
    end = rest.find("\n## ", 1)
    return rest if end < 0 else rest[:end]


def test_the_release_procedure_names_the_pages_setting_as_a_github_one():
    procedure = _section(_read(CHANNELS_MD), "Promotion procedure")
    # The knowledge builder reads a bold arrow path as a Console breadcrumb.
    build = _read(BUILD_APP_KNOWLEDGE)
    pattern = re.search(r'^BREADCRUMB_RE = re\.compile\(r"(.+)"\)$', build, re.MULTILINE)
    assert pattern, "the builder's breadcrumb pattern moved"
    breadcrumb = re.compile(pattern.group(1))
    crumbs = [m.group(1) for m in breadcrumb.finditer(procedure)]
    assert not [c for c in crumbs if "Pages" in c], crumbs
    flat = _flat(procedure)
    assert "In the GitHub repository's own settings, on its Pages page" in flat
    assert "set to **GitHub Actions**; this is a GitHub setting, not a Console one." in flat


def test_the_layout_section_says_which_analytics_pages_share_the_time_range():
    """The intro now names seven pages, so "Each page follows the Overview's layout" with
    its time range read as if Models, Baseline and Jobs had one (XFUI3 review). Only the
    pages the Analytics host renders share the range (`webui/src/soc/pages/Analytics.tsx`,
    `useAnalyticsWindow`); Team activity has its own range control."""
    layout = _flat(_section(_read(ANALYTICS_MD), "How the Analytics pages are laid out"))
    assert "Each page follows the Overview's layout" not in layout
    assert "**Metrics**, **Agent effectiveness** and **Cost** follow the Overview's layout." in layout
    assert "The range you pick on one of these three pages is kept for the other two" in layout
    assert "**Team activity** has its own range" in layout
    assert "**Models**, **Baseline** and **Jobs** show the current state with no time range." in layout
    host = _read(REPO_ROOT / "webui" / "src" / "soc" / "pages" / "Analytics.tsx")
    for route in ("`#/metrics`", "`#/effectiveness`", "`#/cost`"):
        assert route in host
