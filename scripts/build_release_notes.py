#!/usr/bin/env python3
"""Build the What's new release notes from the curated notes in ``docs/releases/notes/``.

Round 16 SPEC D7, S4 and §4.4 WP07. Every release has one curated JSON file,
``docs/releases/notes/<version>.json`` (schema 1), holding dated updates with short
highlights and optional WebP screenshots. This stdlib-only script validates every file
and writes three checked-in outputs:

``webui/src/soc/whats-new/release-notes.gen.json``
    The notes the Console imports lazily for the What's new dialog and the
    Communication, What's new page. It is checked in under ``webui/src`` because the
    Docker Web build stage copies only ``webui/`` and cannot read ``docs/``.
``backend/app/whats_new_latest.json``
    The newest update id. The backend stamps it on every account it creates, so a new
    account starts with What's new marked seen (``app/whats_new.py``).
``docs/releases/whats-new.md``
    The Help Center page: every release, newest first.

The Console reads the newest update id at build time too (``webui/vite.config.ts``
defines ``__AGENTIC_SOC_WHATS_NEW_LATEST__`` from the generated JSON).

The output is deterministic, so a re-run on an unchanged tree rewrites identical bytes.
``--check`` regenerates in memory and fails, naming each stale output, when the
committed files differ; CI runs it in the "Help Center & docs" lane.

The notes are trusted repository content, but they are plain text all the same: the
generator rejects markup, raw URLs, Markdown links, hidden characters, em dashes and en
dashes, and a title that says "Round". Only ``**bold**`` and `` `code` `` are allowed,
which is what the Console's dependency-free renderer draws.
"""

from __future__ import annotations

import argparse
import ast
import datetime as _dt
import json
import re
import sys
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
GENERATOR = "scripts/build_release_notes.py"
SCHEMA = 1

#: Where the curated notes live, and the three outputs (relative to the repository root).
NOTES_DIR = Path("docs/releases/notes")
WEB_OUTPUT = Path("webui/src/soc/whats-new/release-notes.gen.json")
BACKEND_OUTPUT = Path("backend/app/whats_new_latest.json")
DOC_OUTPUT = Path("docs/releases/whats-new.md")

#: Screenshots: a bare file name is read from the release's own folder; a name that
#: starts with ``screenshots/`` reuses a Help Center screenshot.
RELEASE_ASSETS = Path("docs/assets/releases")
SHARED_SCREENSHOTS_PREFIX = "screenshots/"

#: The release-notes file name and ``version`` (the simple release form, no suffix).
VERSION_RE = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")
#: An update id: the dismissed-intro id grammar (``models.py``), the same grammar the
#: backend normalises ``UserPrefs.misc.whats_new_seen`` with.
UPDATE_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_.:-]{0,63}$")
#: A highlight id: the ``h`` deep-link key of ``#/whats_new?v=&h=``.
HIGHLIGHT_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,47}$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
REQUIRES_RE = re.compile(r"^([a-z_]+):([a-z_]+)$")
DOCS_PATH_RE = re.compile(r"^(?:[a-z0-9][a-z0-9._-]*/)+(?:#[a-z0-9][a-z0-9_-]*)?$")
SCREENSHOT_NAME_RE = re.compile(r"^(?:screenshots/)?[a-z0-9][a-z0-9._-]*\.webp$")

STATUSES = ("released", "testing")
#: Keep a Changelog types, in the words the Console shows.
KINDS = ("new", "improved", "fixed", "removed", "security")
AREAS = (
    "cases", "chat", "dashboards", "detection", "intelligence", "automation",
    "security", "administration", "platform", "help",
)
KIND_LABELS = {
    "new": "New", "improved": "Improved", "fixed": "Fixed", "removed": "Removed",
    "security": "Security",
}
AREA_LABELS = {
    "cases": "Cases", "chat": "Chat", "dashboards": "Dashboards", "detection": "Detection",
    "intelligence": "Intelligence", "automation": "Automation", "security": "Security",
    "administration": "Administration", "platform": "Platform", "help": "Help",
}

MAX_TITLE = 80
MAX_SUMMARY = 200
MAX_DETAIL = 280
MAX_DETAILS = 12
MAX_FEATURED = 8
MAX_HIGHLIGHTS = 40
MIN_ALT = 40
MAX_ALT = 400
MAX_CAPTION = 160
MAX_RECORD_SUMMARY = 120
MAX_IMAGE_WIDTH = 2_880
MAX_IMAGE_BYTES = 250 * 1024

RELEASE_KEYS = {"schema", "version", "status", "date", "title", "summary", "docs", "updates", "records"}
RELEASE_REQUIRED = {"schema", "version", "status", "date", "title", "summary", "docs", "updates"}
UPDATE_KEYS = {"id", "date", "title", "highlights"}
HIGHLIGHT_KEYS = {
    "id", "kind", "area", "title", "summary", "details", "featured", "requires", "open",
    "help", "screenshot",
}
HIGHLIGHT_REQUIRED = {"id", "kind", "area", "title", "summary"}
SCREENSHOT_KEYS = {"light", "dark", "alt", "caption"}
RECORD_KEYS = {"version", "date", "summary", "docs"}

# Plain-text rules (the Console renders the notes as text; Help Center page as Markdown).
_BANNED_CHARACTERS = {
    "\u2014": "an em dash",
    "\u2013": "an en dash",
    "\u00a0": "a no-break space",
    "\u202f": "a narrow no-break space",
    "<": "markup (<)",
    ">": "markup (>)",
    "\\": "a backslash",
}
_RAW_URL_RE = re.compile(r"(?i)\b(?:https?|ftp|file|mailto|javascript|data):|www\.|://")
_MARKDOWN_LINK_RE = re.compile(r"\]\(|\]\[|^\s*[#>]|!\[")
_ROUND_RE = re.compile(r"\bRound\b")
_RETIRED_WORD_RE = re.compile(r"(?i)playbook")
_ALT_OPENERS = ("image of", "picture of", "photo of", "screenshot of")


class NotesError(ValueError):
    """The curated notes break a schema rule (the message names the file and field)."""


# --------------------------------------------------------------------------- #
# Repository facts the notes are checked against.
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class Context:
    """What the notes are validated against: read from the repository, never guessed."""

    root: Path
    current_version: str
    console_pages: frozenset[str]
    permissions: frozenset[str]
    public_pages: frozenset[str]
    excluded_assets: frozenset[str]

    @classmethod
    def load(cls, root: Path = ROOT) -> "Context":
        version = (root / "VERSION").read_text(encoding="utf-8").strip()
        if not VERSION_RE.fullmatch(version):
            raise NotesError(f"VERSION is not a release version: {version!r}")
        return cls(
            root=root,
            current_version=version,
            console_pages=_console_pages(root),
            permissions=_permissions(root),
            public_pages=_nav_pages(root),
            excluded_assets=_excluded_assets(root),
        )


def _console_pages(root: Path) -> frozenset[str]:
    """Every Console page id, from the generated console map (``npm run gen:console-map``)."""
    data = json.loads((root / "backend/app/knowledge/console_map.json").read_text(encoding="utf-8"))
    return frozenset(
        str(target["page"]) for target in data.get("targets", []) if target.get("kind") == "page"
    )


def _permissions(root: Path) -> frozenset[str]:
    """Every ``resource:action`` grant, read from ``RESOURCES`` in ``rbac/policy.py``."""
    tree = ast.parse((root / "backend/app/rbac/policy.py").read_text(encoding="utf-8"))
    for node in tree.body:
        target = node.target if isinstance(node, ast.AnnAssign) else (
            node.targets[0] if isinstance(node, ast.Assign) and len(node.targets) == 1 else None
        )
        if isinstance(target, ast.Name) and target.id == "RESOURCES" and node.value is not None:
            resources = ast.literal_eval(node.value)
            return frozenset(
                f"{resource}:{action}" for resource, actions in resources.items() for action in actions
            )
    raise NotesError("backend/app/rbac/policy.py: RESOURCES not found")


def _nav_pages(root: Path) -> frozenset[str]:
    """The public Help Center pages: every ``*.md`` target of the ``mkdocs.yml`` nav."""
    pages: set[str] = set()
    inside = False
    target = re.compile(r"^\s*-\s+(?:[^:]+:\s+)?([^\s]+\.md)\s*$")
    for line in (root / "mkdocs.yml").read_text(encoding="utf-8").splitlines():
        if line == "nav:":
            inside = True
            continue
        if inside and line and not line.startswith(" "):
            break
        if inside:
            match = target.match(line)
            if match:
                pages.add(match.group(1))
    return frozenset(pages)


def _excluded_assets(root: Path) -> frozenset[str]:
    """Asset paths ``mkdocs.yml`` keeps out of the bundled Help Center (``exclude_docs``)."""
    excluded: set[str] = set()
    inside = False
    for line in (root / "mkdocs.yml").read_text(encoding="utf-8").splitlines():
        if line.startswith("exclude_docs:"):
            inside = True
            continue
        if inside:
            if line and not line.startswith(" "):
                break
            entry = line.strip()
            if entry.startswith("assets/"):
                excluded.add(entry)
    return frozenset(excluded)


# --------------------------------------------------------------------------- #
# Field checks.
# --------------------------------------------------------------------------- #
def _where(file: str, path: str) -> str:
    return f"{file}: {path}" if path else file


def check_text(value: Any, *, file: str, path: str, limit: int) -> str:
    """One plain-text field: a non-empty, single-line, bounded string with no markup.

    The Console copy rules apply to every field: no em or en dash, no no-break space,
    no hidden character, never the word "Round" and never "playbook"."""
    where = _where(file, path)
    if not isinstance(value, str):
        raise NotesError(f"{where}: must be a string")
    if value != value.strip() or not value:
        raise NotesError(f"{where}: must be non-empty with no leading or trailing spaces")
    if len(value) > limit:
        raise NotesError(f"{where}: {len(value)} characters, at most {limit}")
    for character in value:
        if unicodedata.category(character) in ("Cc", "Cf", "Zl", "Zp", "Co", "Cn", "Cs"):
            raise NotesError(f"{where}: hidden character U+{ord(character):04X}")
        reason = _BANNED_CHARACTERS.get(character)
        if reason:
            raise NotesError(f"{where}: contains {reason}; the notes are plain text")
    if _RAW_URL_RE.search(value):
        raise NotesError(f"{where}: contains a raw URL; link with `open` or `help` instead")
    if _MARKDOWN_LINK_RE.search(value):
        raise NotesError(f"{where}: contains Markdown link or block syntax; the notes are plain text")
    if value.count("**") % 2 or value.count("`") % 2:
        raise NotesError(f"{where}: an unclosed ** or ` marker")
    if _RETIRED_WORD_RE.search(value):
        raise NotesError(f"{where}: says 'playbook'; the feature is Runbooks")
    if _ROUND_RE.search(value):
        raise NotesError(f"{where}: Console copy never says 'Round'")
    return value


def check_date(value: Any, *, file: str, path: str, nullable: bool) -> str | None:
    where = _where(file, path)
    if value is None:
        if nullable:
            return None
        raise NotesError(f"{where}: a date is required")
    if not isinstance(value, str) or not DATE_RE.fullmatch(value):
        raise NotesError(f"{where}: must be an ISO date (YYYY-MM-DD)")
    try:
        _dt.date.fromisoformat(value)
    except ValueError as exc:
        raise NotesError(f"{where}: not a calendar date ({exc})") from None
    return value


def check_keys(value: Any, *, file: str, path: str, allowed: set[str], required: set[str]) -> dict:
    where = _where(file, path)
    if not isinstance(value, dict):
        raise NotesError(f"{where}: must be an object")
    unknown = sorted(set(value) - allowed)
    if unknown:
        raise NotesError(f"{where}: unknown keys {unknown}")
    missing = sorted(required - set(value))
    if missing:
        raise NotesError(f"{where}: missing keys {missing}")
    return value


def check_docs_path(value: Any, ctx: Context, *, file: str, path: str) -> str:
    """A public Help Center page, written as its URL path (``analyst/case-manager/``)."""
    where = _where(file, path)
    if not isinstance(value, str) or not DOCS_PATH_RE.fullmatch(value):
        raise NotesError(f"{where}: must be a Help Center path such as 'analyst/case-manager/'")
    if docs_page_for(value, ctx.public_pages) is None:
        raise NotesError(f"{where}: {value!r} is not a public Help Center page in the mkdocs.yml nav")
    return value


def docs_page_for(value: str, public_pages: frozenset[str]) -> str | None:
    """The public Markdown page behind a Help Center URL path (the anchor dropped):
    ``analyst/cases/`` is ``analyst/cases.md``, ``getting-started/`` is
    ``getting-started/index.md``."""
    stem = value.split("#", 1)[0].rstrip("/")
    for candidate in (f"{stem}.md", f"{stem}/index.md"):
        if candidate in public_pages:
            return candidate
    return None


def _webp_size(data: bytes, where: str) -> tuple[int, int]:
    """Width and height from a WebP header (VP8, VP8L or VP8X), never by decoding."""
    if len(data) < 30 or data[:4] != b"RIFF" or data[8:12] != b"WEBP":
        raise NotesError(f"{where}: not a WebP file (RIFF/WEBP magic)")
    chunk = data[12:16]
    if chunk == b"VP8X":
        width = 1 + int.from_bytes(data[24:27], "little")
        height = 1 + int.from_bytes(data[27:30], "little")
    elif chunk == b"VP8 ":
        if data[23:26] != b"\x9d\x01\x2a":
            raise NotesError(f"{where}: a VP8 frame without its start code")
        width = int.from_bytes(data[26:28], "little") & 0x3FFF
        height = int.from_bytes(data[28:30], "little") & 0x3FFF
    elif chunk == b"VP8L":
        if data[20] != 0x2F:
            raise NotesError(f"{where}: a VP8L stream without its signature")
        bits = int.from_bytes(data[21:25], "little")
        width = (bits & 0x3FFF) + 1
        height = ((bits >> 14) & 0x3FFF) + 1
    else:
        raise NotesError(f"{where}: an unknown WebP chunk {chunk!r}")
    if width <= 0 or height <= 0:
        raise NotesError(f"{where}: a WebP header with no size")
    return width, height


def check_image(name: Any, version: str, ctx: Context, *, file: str, path: str) -> dict[str, Any]:
    """One screenshot file: exists, served by the Help Center, WebP, sized from its header."""
    where = _where(file, path)
    if not isinstance(name, str) or not SCREENSHOT_NAME_RE.fullmatch(name):
        raise NotesError(
            f"{where}: a lower-case .webp file name, or 'screenshots/<name>.webp' to reuse one"
        )
    if name.startswith(SHARED_SCREENSHOTS_PREFIX):
        relative = f"assets/{name}"
    else:
        relative = f"{RELEASE_ASSETS.relative_to('docs').as_posix()}/{version}/{name}"
    if relative in ctx.excluded_assets:
        raise NotesError(f"{where}: docs/{relative} is excluded from the Help Center bundle")
    absolute = ctx.root / "docs" / relative
    if not absolute.is_file():
        raise NotesError(f"{where}: docs/{relative} does not exist")
    size = absolute.stat().st_size
    if size > MAX_IMAGE_BYTES:
        raise NotesError(f"{where}: {size:,} bytes, at most {MAX_IMAGE_BYTES:,}")
    with absolute.open("rb") as handle:
        header = handle.read(64)
    width, height = _webp_size(header, where)
    if width > MAX_IMAGE_WIDTH:
        raise NotesError(f"{where}: {width} px wide, at most {MAX_IMAGE_WIDTH}")
    return {"src": relative, "width": width, "height": height}


# --------------------------------------------------------------------------- #
# One release file.
# --------------------------------------------------------------------------- #
def _version_key(version: str) -> tuple[int, int, int]:
    match = VERSION_RE.fullmatch(version)
    assert match is not None
    return (int(match.group(1)), int(match.group(2)), int(match.group(3)))


def validate_release(raw: Any, file_name: str, ctx: Context) -> dict[str, Any]:
    """Validate one notes file and return its normalised form (the generated shape)."""
    file = f"{NOTES_DIR.as_posix()}/{file_name}"
    data = check_keys(raw, file=file, path="", allowed=RELEASE_KEYS, required=RELEASE_REQUIRED)
    if data["schema"] != SCHEMA:
        raise NotesError(f"{file}: schema must be {SCHEMA}")
    version = data["version"]
    if not isinstance(version, str) or not VERSION_RE.fullmatch(version):
        raise NotesError(f"{file}: version must be a release version such as '0.2.0'")
    if file_name != f"{version}.json":
        raise NotesError(f"{file}: the file name must be {version}.json")
    status = data["status"]
    if status not in STATUSES:
        raise NotesError(f"{file}: status must be one of {list(STATUSES)}")
    if status == "testing" and version != ctx.current_version:
        raise NotesError(
            f"{file}: only the current version ({ctx.current_version}) may have status 'testing'"
        )
    if status == "testing" and _version_key(version) < _version_key(ctx.current_version):
        raise NotesError(f"{file}: an older version cannot be 'testing'")
    testing = status == "testing"
    date = check_date(data["date"], file=file, path="date", nullable=testing)
    out: dict[str, Any] = {
        "version": version,
        "status": status,
        "date": date,
        "title": check_text(data["title"], file=file, path="title", limit=MAX_TITLE),
        "summary": check_text(data["summary"], file=file, path="summary", limit=MAX_SUMMARY),
        "docs": check_docs_path(data["docs"], ctx, file=file, path="docs"),
        "updates": [],
        "records": [],
    }

    updates = data["updates"]
    if not isinstance(updates, list) or not updates:
        raise NotesError(f"{file}: updates must be a non-empty list, newest first")
    highlight_ids: set[str] = set()
    previous_date: str | None = None
    seen_dated = False
    for index, raw_update in enumerate(updates):
        path = f"updates[{index}]"
        update = check_keys(raw_update, file=file, path=path, allowed=UPDATE_KEYS, required=UPDATE_KEYS)
        update_id = update["id"]
        if not isinstance(update_id, str) or not UPDATE_ID_RE.fullmatch(update_id):
            raise NotesError(f"{file}: {path}.id must match {UPDATE_ID_RE.pattern}")
        if not update_id.startswith(f"{version}."):
            raise NotesError(f"{file}: {path}.id must start with '{version}.'")
        update_date = check_date(update["date"], file=file, path=f"{path}.date", nullable=testing)
        if update_date is None:
            if seen_dated:
                raise NotesError(f"{file}: {path} is undated after a dated update; newest first")
        else:
            seen_dated = True
            if previous_date is not None and update_date > previous_date:
                raise NotesError(f"{file}: {path}.date {update_date} is newer than the update before it")
            if date is not None and update_date > date:
                raise NotesError(f"{file}: {path}.date {update_date} is after the release date {date}")
            previous_date = update_date
        highlights = update["highlights"]
        if not isinstance(highlights, list) or not highlights:
            raise NotesError(f"{file}: {path}.highlights must be a non-empty list")
        if len(highlights) > MAX_HIGHLIGHTS:
            raise NotesError(f"{file}: {path}.highlights holds {len(highlights)}, at most {MAX_HIGHLIGHTS}")
        normalised_highlights = [
            validate_highlight(item, version, ctx, file=file, path=f"{path}.highlights[{h}]")
            for h, item in enumerate(highlights)
        ]
        featured = sum(1 for item in normalised_highlights if item["featured"])
        if featured > MAX_FEATURED:
            raise NotesError(f"{file}: {path} features {featured} highlights, at most {MAX_FEATURED}")
        for item in normalised_highlights:
            if item["id"] in highlight_ids:
                raise NotesError(f"{file}: highlight id {item['id']!r} is used twice in this release")
            highlight_ids.add(item["id"])
        out["updates"].append({
            "id": update_id,
            "date": update_date,
            "title": check_text(update["title"], file=file, path=f"{path}.title", limit=MAX_TITLE),
            "highlights": normalised_highlights,
        })

    records = data.get("records", [])
    if not isinstance(records, list):
        raise NotesError(f"{file}: records must be a list")
    record_versions: set[str] = set()
    for index, raw_record in enumerate(records):
        path = f"records[{index}]"
        record = check_keys(raw_record, file=file, path=path, allowed=RECORD_KEYS, required=RECORD_KEYS)
        record_version = record["version"]
        if not isinstance(record_version, str) or not VERSION_RE.fullmatch(record_version):
            raise NotesError(f"{file}: {path}.version must be a release version")
        if _version_key(record_version) >= _version_key(version):
            raise NotesError(f"{file}: {path}.version {record_version} is not older than {version}")
        if record_version in record_versions:
            raise NotesError(f"{file}: {path}.version {record_version} is listed twice")
        record_versions.add(record_version)
        out["records"].append({
            "version": record_version,
            "date": check_date(record["date"], file=file, path=f"{path}.date", nullable=False),
            "summary": check_text(record["summary"], file=file, path=f"{path}.summary", limit=MAX_RECORD_SUMMARY),
            "docs": check_docs_path(record["docs"], ctx, file=file, path=f"{path}.docs"),
        })
    out["records"].sort(key=lambda item: _version_key(item["version"]), reverse=True)
    return out


def validate_highlight(raw: Any, version: str, ctx: Context, *, file: str, path: str) -> dict[str, Any]:
    item = check_keys(raw, file=file, path=path, allowed=HIGHLIGHT_KEYS, required=HIGHLIGHT_REQUIRED)
    highlight_id = item["id"]
    if not isinstance(highlight_id, str) or not HIGHLIGHT_ID_RE.fullmatch(highlight_id):
        raise NotesError(f"{file}: {path}.id must match {HIGHLIGHT_ID_RE.pattern}")
    if item["kind"] not in KINDS:
        raise NotesError(f"{file}: {path}.kind must be one of {list(KINDS)}")
    if item["area"] not in AREAS:
        raise NotesError(f"{file}: {path}.area must be one of {list(AREAS)}")
    details = item.get("details", [])
    if not isinstance(details, list) or len(details) > MAX_DETAILS:
        raise NotesError(f"{file}: {path}.details must be a list of at most {MAX_DETAILS}")
    featured = item.get("featured", False)
    if not isinstance(featured, bool):
        raise NotesError(f"{file}: {path}.featured must be true or false")
    requires = item.get("requires")
    if requires is not None:
        if not isinstance(requires, str) or not REQUIRES_RE.fullmatch(requires):
            raise NotesError(f"{file}: {path}.requires must be 'resource:action'")
        if requires not in ctx.permissions:
            raise NotesError(f"{file}: {path}.requires {requires!r} is not a permission")
    open_target = item.get("open")
    page: str | None = None
    if open_target is not None:
        check_keys(open_target, file=file, path=f"{path}.open", allowed={"page"}, required={"page"})
        page = open_target["page"]
        if page not in ctx.console_pages:
            raise NotesError(f"{file}: {path}.open.page {page!r} is not a Console page (console_map.json)")
    help_path = item.get("help")
    if help_path is not None:
        help_path = check_docs_path(help_path, ctx, file=file, path=f"{path}.help")

    screenshot = item.get("screenshot")
    shot: dict[str, Any] | None = None
    if screenshot is not None:
        check_keys(screenshot, file=file, path=f"{path}.screenshot", allowed=SCREENSHOT_KEYS, required={"light", "alt"})
        alt = check_text(screenshot["alt"], file=file, path=f"{path}.screenshot.alt", limit=MAX_ALT)
        if len(alt) < MIN_ALT:
            raise NotesError(f"{file}: {path}.screenshot.alt needs at least {MIN_ALT} characters")
        if alt.lower().startswith(_ALT_OPENERS):
            raise NotesError(f"{file}: {path}.screenshot.alt describes the picture, not 'image of'")
        shot = {
            "light": check_image(screenshot["light"], version, ctx, file=file, path=f"{path}.screenshot.light"),
            "dark": None,
            "alt": alt,
            "caption": None,
        }
        if screenshot.get("dark") is not None:
            shot["dark"] = check_image(screenshot["dark"], version, ctx, file=file, path=f"{path}.screenshot.dark")
        if screenshot.get("caption") is not None:
            shot["caption"] = check_text(
                screenshot["caption"], file=file, path=f"{path}.screenshot.caption", limit=MAX_CAPTION
            )
    if featured and (shot is None or shot["dark"] is None):
        raise NotesError(f"{file}: {path} is featured, so it needs a light and a dark screenshot")

    return {
        "id": highlight_id,
        "kind": item["kind"],
        "area": item["area"],
        "title": check_text(item["title"], file=file, path=f"{path}.title", limit=MAX_TITLE),
        "summary": check_text(item["summary"], file=file, path=f"{path}.summary", limit=MAX_SUMMARY),
        "details": [
            check_text(detail, file=file, path=f"{path}.details[{d}]", limit=MAX_DETAIL)
            for d, detail in enumerate(details)
        ],
        "featured": featured,
        "requires": requires,
        "open": page,
        "help": help_path,
        "screenshot": shot,
    }


# --------------------------------------------------------------------------- #
# The whole notes set and its three outputs.
# --------------------------------------------------------------------------- #
@dataclass
class Notes:
    releases: list[dict[str, Any]] = field(default_factory=list)
    #: The public Help Center pages the links resolve against (``Context.public_pages``).
    pages: frozenset[str] = frozenset()

    @property
    def latest(self) -> str:
        return self.releases[0]["updates"][0]["id"]


def load_notes(ctx: Context, notes_dir: Path | None = None) -> Notes:
    directory = notes_dir or (ctx.root / NOTES_DIR)
    files = sorted(directory.glob("*.json"))
    if not files:
        raise NotesError(f"{NOTES_DIR.as_posix()}: no release notes")
    releases: list[dict[str, Any]] = []
    for path in files:
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise NotesError(f"{NOTES_DIR.as_posix()}/{path.name}: not valid JSON ({exc})") from None
        releases.append(validate_release(raw, path.name, ctx))
    releases.sort(key=lambda release: _version_key(release["version"]), reverse=True)
    if releases[0]["version"] != ctx.current_version:
        raise NotesError(
            f"{NOTES_DIR.as_posix()}: the newest notes are for {releases[0]['version']}, "
            f"but VERSION is {ctx.current_version}; add {ctx.current_version}.json"
        )
    seen_updates: set[str] = set()
    covered: dict[str, str] = {}
    for release in releases:
        for update in release["updates"]:
            if update["id"] in seen_updates:
                raise NotesError(f"update id {update['id']!r} is used in more than one release")
            seen_updates.add(update["id"])
        for record in release["records"]:
            if record["version"] in covered or any(r["version"] == record["version"] for r in releases):
                raise NotesError(f"{record['version']} is listed as a record more than once or has notes")
            covered[record["version"]] = release["version"]
    return Notes(releases=releases, pages=ctx.public_pages)


def web_output(notes: Notes) -> str:
    payload = {
        "schema": SCHEMA,
        "generated_by": GENERATOR,
        "latest": notes.latest,
        "releases": notes.releases,
    }
    return json.dumps(payload, ensure_ascii=False, indent=2) + "\n"


def backend_output(notes: Notes) -> str:
    payload = {
        "schema": SCHEMA,
        "generated_by": GENERATOR,
        "version": notes.releases[0]["version"],
        "latest_update_id": notes.latest,
    }
    return json.dumps(payload, ensure_ascii=False, indent=2) + "\n"


_MONTHS = (
    "January", "February", "March", "April", "May", "June", "July", "August", "September",
    "October", "November", "December",
)


def long_date(value: str) -> str:
    day = _dt.date.fromisoformat(value)
    return f"{day.day} {_MONTHS[day.month - 1]} {day.year}"


def _md_link(docs_path: str, pages: frozenset[str]) -> str:
    """A relative Markdown link from ``docs/releases/`` to a Help Center URL path."""
    page, _, anchor = docs_path.partition("#")
    target = docs_page_for(page, pages)
    assert target is not None, docs_path  # validated on load
    relative = target[len("releases/"):] if target.startswith("releases/") else f"../{target}"
    return f"{relative}#{anchor}" if anchor else relative


def _figure(shot: dict[str, Any]) -> list[str]:
    """A screenshot as the Help Center's light and dark figure (``#only-light``)."""
    lines = ['<figure markdown="span">']
    for theme in ("light", "dark"):
        image = shot[theme]
        if image is None:
            continue
        source = f"../{image['src']}"
        suffix = f"#only-{theme}" if shot["dark"] is not None else ""
        lines.append(f"[![{shot['alt']}]({source}{suffix}) ]({source})")
    if shot["caption"]:
        lines.append(f"<figcaption>{shot['caption']}</figcaption>")
    lines.append("</figure>")
    return lines


def doc_output(notes: Notes) -> str:
    def link(path: str) -> str:
        return _md_link(path, notes.pages)

    this_page = DOC_OUTPUT.relative_to("docs").as_posix()

    lines: list[str] = [
        "---",
        "title: What's new",
        "description: Every Agentic SOC release with its highlights, newest first.",
        "---",
        "",
        "<!-- Generated by scripts/build_release_notes.py from docs/releases/notes/. Edit the",
        "     notes there and run the script; never edit this page by hand. -->",
        "",
        "# What's new",
        "",
        "Every Agentic SOC release with its highlights, newest first. The same notes ship",
        "with the Console: open **Communication → What's new**. After a release is",
        "installed, the Console shows a short welcome once you sign in. Turn it off with",
        "**Show What's new after updates** in Settings, Appearance. With sign-in turned",
        "off, everyone shares one set of preferences, so the welcome shows once per",
        "installation.",
        "",
        "Each release record holds the full notes and the known limits of that release.",
        "",
    ]
    for release in notes.releases:
        lines += [f"## Agentic SOC {release['version']}", ""]
        if release["status"] == "testing":
            state = "Testing candidate, not yet released."
        else:
            state = f"Released {long_date(release['date'])}."
        lines += [f"{state} {release['title']}. {release['summary']}", ""]
        lines += [f"Read the [Agentic SOC {release['version']} release record]({link(release['docs'])}).", ""]
        # Lets chat's product help find this page for "what changed in this version".
        lines += ["What changed in this version, newest first.", ""]
        for update in release["updates"]:
            # The heading is the date alone and the title opens the section: chat's product
            # help weighs a heading three times, and a title naming features (such as
            # "required MFA") would outrank the page that explains the feature.
            when = long_date(update["date"]) if update["date"] else "Not yet released"
            lines += [f"### {when}", "", f"{update['title']}.", ""]
            for item in update["highlights"]:
                kind, area = KIND_LABELS[item["kind"]], AREA_LABELS[item["area"]]
                tags = kind if kind == area else f"{kind}, {area}"
                text = f"- **{item['title']}** ({tags}). {item['summary']}"
                # A highlight that points at this very page needs no link to itself.
                if item["help"] and docs_page_for(item["help"], notes.pages) != this_page:
                    text += f" [Read more]({link(item['help'])})."
                lines.append(text)
                lines += [f"    - {detail}" for detail in item["details"]]
                if item["screenshot"]:
                    # A figure ends the list; the next highlight starts a new one.
                    lines += ["", *_figure(item["screenshot"]), ""]
            lines.append("")
        if release["records"]:
            lines += [f"### Earlier release records folded into {release['version']}", ""]
            for record in release["records"]:
                lines.append(
                    f"- [Agentic SOC {record['version']}]({link(record['docs'])}), "
                    f"{long_date(record['date'])}. {record['summary']}."
                )
            lines.append("")
    text = "\n".join(lines).strip("\n") + "\n"
    # A figure at the end of an update leaves a doubled blank line; keep one.
    return re.sub(r"\n{3,}", "\n\n", text)


def outputs(notes: Notes) -> dict[Path, str]:
    return {
        WEB_OUTPUT: web_output(notes),
        BACKEND_OUTPUT: backend_output(notes),
        DOC_OUTPUT: doc_output(notes),
    }


def stale_outputs(root: Path, rendered: dict[Path, str]) -> list[str]:
    """The outputs whose committed bytes differ from a fresh render (LF compared)."""
    stale: list[str] = []
    for relative, text in rendered.items():
        path = root / relative
        current = path.read_text(encoding="utf-8").replace("\r\n", "\n") if path.is_file() else None
        if current != text:
            stale.append(relative.as_posix())
    return stale


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--check", action="store_true", help="fail when a committed output is stale")
    args = parser.parse_args(argv)
    try:
        ctx = Context.load(ROOT)
        notes = load_notes(ctx)
    except NotesError as exc:
        print(f"build_release_notes: {exc}", file=sys.stderr)
        return 1
    rendered = outputs(notes)
    if args.check:
        stale = stale_outputs(ROOT, rendered)
        if stale:
            print("build_release_notes: stale generated outputs (run scripts/build_release_notes.py):", file=sys.stderr)
            for name in stale:
                print(f"  - {name}", file=sys.stderr)
            return 1
        print(f"Release notes are current: {len(notes.releases)} release(s), newest update {notes.latest}")
        return 0
    for relative, text in rendered.items():
        path = ROOT / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8", newline="\n")
    print(f"Wrote {len(rendered)} outputs: {len(notes.releases)} release(s), newest update {notes.latest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
