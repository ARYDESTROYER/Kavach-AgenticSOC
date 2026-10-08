#!/usr/bin/env python3
"""Build the version-matched app-knowledge corpus Workspace Chat answers from.

Chat revamp SPEC §5.4. The backend image ships only ``backend/app`` (its build context
is ``../backend`` in the frozen compose base), so the public Help Center cannot reach
the backend at runtime. This script derives a compact, reviewable copy of it and
commits it under ``backend/app/knowledge/``:

``app_docs.json``
    The public MkDocs nav pages of the "guide" and "operate" tiers, chunked by H2/H3
    section (about 1.4k characters per chunk). Every chunk carries the exact anchor the
    Help Center uses, because the anchors come from Python-Markdown run with
    ``mkdocs.yml``'s own extension and ``toc`` configuration (``md.toc_tokens``), never
    from a reimplemented slugify. Bold console breadcrumbs (``**Settings → General →
    Models**``) are resolved against ``console_map.json`` into console target ids; one
    that resolves to nothing fails the build unless it is on the explicit allowlist of
    arrow paths that are not console destinations.
``aliases.json``
    The curated product-vocabulary synonyms retrieval expands queries with.
``manifest.json``
    The sha256 of each of the four files' siblings, the product version and the docs
    line. The backend loader verifies it and fails closed on any mismatch.

``console_map.json`` is NOT written here: it is derived from the webui registries by
``webui/src/soc/__tests__/console-map.contract.test.ts`` (``npm run gen:console-map``).
Regenerate it first, then run this script, because the manifest pins its hash.

The output is deterministic (no timestamps, no commit ids), so re-running the script
on an unchanged tree rewrites identical bytes. ``--check`` regenerates in memory and
fails, listing the changed chunk ids, when the committed corpus is stale; CI runs it in
the "Help Center & docs" lane.

The script needs the pinned docs toolchain (``markdown`` + MkDocs). When the current
interpreter lacks it, the script re-runs itself under the interpreter that
``run_docs_bundle.resolve_python()`` selects (bootstrapping ``.docs-venv`` if needed).
"""

from __future__ import annotations

import argparse
import hashlib
import html
import importlib.util
import json
import os
import re
import sys
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / "docs"
OUT_DIR = ROOT / "backend" / "app" / "knowledge"
SCHEMA = 1
GENERATOR = "scripts/build_app_knowledge.py"
_REEXEC_FLAG = "AGENTIC_SOC_APP_KNOWLEDGE_REEXEC"

SEMVER = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:[-+][0-9A-Za-z.+-]+)?$")

# --------------------------------------------------------------------------- #
# Corpus selection (docs-corpus research §2.1). Only public nav pages are eligible.
# "guide" is how to use and administer the product; "operate" is install, deploy and
# upgrade material, ranked slightly lower so "how do I…" favours the user guides.
# Contributor docs, the API reference and historical release records are excluded:
# they are long, engineering-facing, or describe releases that are not installed.
# --------------------------------------------------------------------------- #
GUIDE_PREFIXES = (
    "getting-started/", "analyst/", "automation/", "intelligence/", "administration/",
    "sources/", "concepts/",
)
GUIDE_EXACT = frozenset({"index.md", "architecture/ingestion.md", "reference/permissions.md"})
OPERATE_PREFIXES = ("operations/",)
OPERATE_EXACT_BASE = frozenset({
    "getting-started/install.md", "reference/configuration.md", "reference/security.md",
    "releases/known-limitations.md", "releases/channels.md",
})

TARGET_CHARS = 1_400
HARD_CHARS = 2_200
MIN_SECTION_CHARS = 40
# Link-list sections whose text is only the titles of other pages (links become their
# text). They would match every query naming those pages and answer none of them.
SKIPPED_HEADINGS = frozenset({"related pages", "related", "see also", "next steps"})

# Curated product vocabulary (query expansion, weight 0.5 in retrieval). Keys and
# values are lower-case tokens as the index tokenises them. Keep it small, reviewed
# and product-specific; every entry exists because a real phrasing missed without it.
ALIASES: dict[str, list[str]] = {
    "2fa": ["mfa", "two-factor", "totp"],
    "mfa": ["two-factor", "totp", "authenticator"],
    "two-factor": ["mfa", "totp"],
    "totp": ["mfa", "two-factor"],
    "sso": ["single", "sign-on", "oidc"],
    "oidc": ["sso", "single", "sign-on"],
    "login": ["sign-in", "authentication"],
    "connect": ["source", "connector"],
    "integrate": ["source", "connector"],
    "ingest": ["source", "ingestion"],
    "siem": ["source", "connector"],
    "kpi": ["metric"],
    "kpis": ["metrics"],
    "metric": ["kpi"],
    "mtta": ["acknowledge", "response"],
    "mttr": ["resolve", "resolution"],
    "mttd": ["detect", "detection"],
    "autoclose": ["auto-close"],
    "budget": ["spend", "cost"],
    "spend": ["cost", "budget"],
    "price": ["cost", "pricing"],
    "pricing": ["cost", "price"],
    "tokens": ["usage", "cost"],
    "slack": ["notifications", "webhook"],
    "teams": ["notifications", "webhook"],
    "pagerduty": ["notifications", "webhook"],
    "email": ["notifications", "smtp"],
    "llm": ["model", "models"],
    "ai": ["model", "agent"],
    "openai": ["model", "provider"],
    "anthropic": ["model", "provider"],
    "litellm": ["model", "self-hosted"],
    "user": ["users"],
    "users": ["rbac", "accounts"],
    "account": ["users"],
    "permission": ["permissions", "rbac", "role"],
    "permissions": ["rbac", "role"],
    "role": ["roles", "rbac"],
    "roles": ["rbac", "permissions"],
    "export": ["data", "archive"],
    "backup": ["export", "restore"],
    "upgrade": ["upgrades", "update"],
    "update": ["upgrades", "release"],
    "reset": ["factory", "danger"],
    "automatically": ["auto-close", "automatic"],
    "automatic": ["auto-close"],
    "risk": ["risk-score"],
    "needs_human": ["needs", "human"],
    "noise": ["funnel", "reduction"],
    "funnel": ["noise", "reduction"],
    "demo": ["demo-mode"],
    "chat": ["workspace"],
    "assistant": ["chat"],
    "report": ["reports"],
    "dashboard": ["overview"],
    "playbook": ["playbooks"],
    "runbook": ["runbooks"],
}

# Characters the build drops outright: controls (TAB/LF kept), format characters,
# line/paragraph separators and the remaining members of the backend's shared
# invisible set (variation selectors, fillers, tag characters). The corpus is
# maintainer prose; nothing legitimate needs them, and the backend test pins that the
# result is a fixed point of the prompt normaliser.
_DROPPED_CATEGORIES = frozenset({"Cc", "Cf", "Zl", "Zp", "Cs", "Co", "Cn"})
_DROPPED_RANGES = (
    (0x034F, 0x034F), (0x115F, 0x1160), (0x17B4, 0x17B5), (0x180B, 0x180F),
    (0x3164, 0x3164), (0xFE00, 0xFE0F), (0xFFA0, 0xFFA0), (0xE0000, 0xE0FFF),
)
# Every character whose NFKC form is an angle bracket. A run of three is the start of
# a fence marker (``<<<UNTRUSTED_LOG_DATA>>>``, ``<<<APP_DOCS>>>``); the build never
# lets one through, so trusted product text can never imitate a block boundary.
_LT_RUN = re.compile("[<﹤＜]{3,}")
_GT_RUN = re.compile("[>﹥＞]{3,}")

FRONT_RE = re.compile(r"^---\n(.*?)\n---\n", re.S)
HEADING_RE = re.compile(r"^(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$")
FENCE_RE = re.compile(r"^(?P<marker>`{3,}|~{3,})(?P<info>.*)$")
ADMONITION_RE = re.compile(r'^(?:!!!|\?\?\?\+?)[ \t]+(?P<kind>[\w-]+)(?:[ \t]+"(?P<title>[^"]*)")?[ \t]*$')
TAB_RE = re.compile(r'^===\+?[ \t]+"(?P<title>[^"]+)"[ \t]*$')
IMAGE_RE = re.compile(r"!\[[^\]]*\]\([^)]*\)")
LINK_RE = re.compile(r"\[([^\]]+)\]\((?:[^()]|\([^)]*\))*\)")
REF_LINK_RE = re.compile(r"\[([^\]]+)\]\[[^\]]*\]")
HTML_TAG_RE = re.compile(r"</?[A-Za-z][^>\n]*>")
ATTR_LIST_RE = re.compile(r"\{:?[ \t]*[#.][^}\n]*\}")
BREADCRUMB_RE = re.compile(r"\*\*([^*\n]+?(?:[ \t]+→[ \t]+[^*\n]+?)+)\*\*")
# Bold arrow paths that are deliberately NOT console destinations. Any other breadcrumb
# that resolves to no console target fails the build (and ``--check``), so a renamed page
# or Settings section cannot leave the Help Center pointing at a place that is gone.
# Partial resolutions (a tab inside a page) stay warnings: the page itself is right.
UNRESOLVED_BREADCRUMB_ALLOWLIST = frozenset({
    "Options → Type out answers",     # a menu inside the chat composer, not a page
    "Case Manager → Chat",            # a tab of the Case Manager detail pane
    "Open source → Edit",             # buttons on the Playbooks page
    "Settings → Pages → Source",      # GitHub's repository settings (release procedure)
    # The Reports page ships with the chat reports package; until its PageId is in the
    # registry (and the console map is regenerated) this crumb cannot resolve.
    "Triage → Workspace → Reports",
})


# --------------------------------------------------------------------------- #
# Toolchain.
# --------------------------------------------------------------------------- #
def _ensure_toolchain(argv: list[str]) -> None:
    """Re-run under the docs toolchain interpreter when ``markdown``/MkDocs are missing."""
    try:
        import markdown  # noqa: F401
        import mkdocs  # noqa: F401
        return
    except ImportError:
        pass
    if os.environ.get(_REEXEC_FLAG):
        raise SystemExit("build_app_knowledge: the docs toolchain (markdown, mkdocs) is not importable")
    spec = importlib.util.spec_from_file_location("run_docs_bundle", ROOT / "scripts" / "run_docs_bundle.py")
    if spec is None or spec.loader is None:
        raise SystemExit("build_app_knowledge: cannot load scripts/run_docs_bundle.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    python = module.resolve_python()
    env = dict(os.environ, **{_REEXEC_FLAG: "1"})
    os.execve(str(python), [str(python), str(Path(__file__).resolve()), *argv], env)


def product_version() -> str:
    value = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
    if not SEMVER.fullmatch(value):
        raise ValueError(f"VERSION is not valid SemVer: {value!r}")
    return value


def docs_line(version: str) -> str:
    match = SEMVER.fullmatch(version)
    assert match is not None
    return f"{match.group(1)}.{match.group(2)}"


# --------------------------------------------------------------------------- #
# Text hygiene.
# --------------------------------------------------------------------------- #
def _dropped(ch: str) -> bool:
    if ch in "\t\n":
        return False
    code = ord(ch)
    if any(lo <= code <= hi for lo, hi in _DROPPED_RANGES):
        return True
    return unicodedata.category(ch) in _DROPPED_CATEGORIES


def scrub(text: str) -> str:
    """Drop invisible characters and break any three-bracket run (marker hygiene)."""
    if not text.isascii() or any(ord(c) < 32 and c not in "\t\n" for c in text):
        text = "".join(c for c in text if not _dropped(c))
    text = _LT_RUN.sub("<<", text)
    return _GT_RUN.sub(">>", text)


def clean_inline(line: str) -> str:
    """One prose line as plain-ish text: links keep their text, images, HTML tags and
    attribute lists go; emphasis and inline code stay (the model and the extractive
    answer both read them well)."""
    line = IMAGE_RE.sub("", line)
    line = LINK_RE.sub(lambda m: m.group(1), line)
    line = REF_LINK_RE.sub(lambda m: m.group(1), line)
    line = HTML_TAG_RE.sub("", line)
    line = ATTR_LIST_RE.sub("", line)
    return html.unescape(line).rstrip()


def norm_label(value: str) -> str:
    value = value.replace("’", "'").replace("“", "").replace("”", "").replace('"', "")
    return " ".join(value.strip().casefold().split())


# --------------------------------------------------------------------------- #
# Configuration and navigation.
# --------------------------------------------------------------------------- #
def load_mkdocs_config() -> Any:
    from mkdocs.config import load_config

    return load_config(config_file=str(ROOT / "mkdocs.yml"))


def nav_pages(nav: Any, trail: tuple[str, ...] = ()) -> list[tuple[str, list[str]]]:
    """``[(page, breadcrumb)]`` in nav order from MkDocs' parsed nav."""
    out: list[tuple[str, list[str]]] = []
    for item in nav or []:
        if isinstance(item, dict):
            for label, value in item.items():
                if isinstance(value, str):
                    out.append((value, [*trail, str(label)]))
                else:
                    out.extend(nav_pages(value, (*trail, str(label))))
        elif isinstance(item, str):
            out.append((item, list(trail)))
    return out


def tier_for(page: str, version: str) -> str | None:
    if page in OPERATE_EXACT_BASE or page == f"releases/{version}.md" or page.startswith(OPERATE_PREFIXES):
        return "operate"
    if page in GUIDE_EXACT or page.startswith(GUIDE_PREFIXES):
        return "guide"
    return None


def url_path(page: str) -> str:
    stem = page[:-3]
    if stem == "index":
        return ""
    if stem.endswith("/index"):
        return stem[: -len("index")]
    return f"{stem}/"


# --------------------------------------------------------------------------- #
# Console breadcrumbs.
# --------------------------------------------------------------------------- #
@dataclass
class ConsoleResolver:
    """Resolves a bold ``A → B → C`` breadcrumb to a console-map target id."""

    targets: list[dict[str, Any]]
    _crumbs: list[tuple[str, list[str]]] = field(default_factory=list)

    def __post_init__(self) -> None:
        self._crumbs = [(t["id"], [norm_label(c) for c in t.get("crumb") or []]) for t in self.targets]

    def resolve(self, segments: list[str]) -> tuple[str | None, bool]:
        """``(target id, complete)``. Tries the whole breadcrumb, then shorter prefixes
        (a trailing segment can be a tab or button the map does not model). A prefix
        must keep at least two segments so "Settings → Pages" (GitHub) never resolves
        to the console Settings page by its first word alone."""
        wanted = [norm_label(s) for s in segments]
        for length in range(len(wanted), 0, -1):
            if length < 2 and len(wanted) >= 2:
                break
            head, last = wanted[: length - 1], wanted[length - 1]
            matches = [
                (len(crumb), target_id)
                for target_id, crumb in self._crumbs
                if crumb and crumb[-1] == last and _is_subsequence(head, crumb[:-1])
            ]
            if matches:
                return min(matches)[1], length == len(wanted)
        return None, False


def _is_subsequence(needle: list[str], haystack: list[str]) -> bool:
    position = 0
    for item in needle:
        try:
            position = haystack.index(item, position) + 1
        except ValueError:
            return False
    return True


# --------------------------------------------------------------------------- #
# Page parsing and chunking.
# --------------------------------------------------------------------------- #
@dataclass
class Section:
    level: int
    heading: str
    anchor: str
    lines: list[str] = field(default_factory=list)


def flat_toc(tokens: Iterable[dict[str, Any]]) -> list[tuple[int, str, str]]:
    out: list[tuple[int, str, str]] = []
    for token in tokens:
        out.append((int(token["level"]), str(token["id"]), html.unescape(str(token["name"]))))
        out.extend(flat_toc(token.get("children") or []))
    return out


def split_sections(page: str, body: str, toc: list[tuple[int, str, str]], title: str) -> tuple[str, list[Section]]:
    """Walk the Markdown source and split it at headings, taking each heading's anchor
    from the matching ``toc_tokens`` entry (document order). Admonition and tab bodies
    are de-indented; fenced code is kept verbatim (commands and env names are what
    operators ask about) except Mermaid, which becomes ``[diagram omitted]``."""
    sections: list[Section] = [Section(1, "", "")]
    page_title = title
    toc_index = 0
    stack: list[int] = []          # body indent of each open admonition/tab
    fence: tuple[str, int] | None = None   # (marker, indent) of the open fence
    mermaid = False
    for raw in body.splitlines():
        expanded = raw.expandtabs(4)
        stripped = expanded.lstrip(" ")
        indent = len(expanded) - len(stripped)
        if fence is None and stripped:
            while stack and indent < stack[-1]:
                stack.pop()
        base = stack[-1] if stack else 0
        line = expanded[min(indent, base):] if stripped else ""
        current = sections[-1]
        if fence is not None:
            marker, _ = fence
            if line.strip().startswith(marker) and set(line.strip()) == {marker[0]}:
                fence = None
                if not mermaid:
                    current.lines.append(line)
                mermaid = False
            elif not mermaid:
                current.lines.append(line)
            continue
        opened = FENCE_RE.match(line.lstrip(" "))
        if opened:
            fence = (opened.group("marker"), indent)
            mermaid = opened.group("info").strip().lower().startswith("mermaid")
            current.lines.append("[diagram omitted]" if mermaid else line)
            continue
        heading = HEADING_RE.match(line)
        if heading:
            if toc_index >= len(toc):
                raise ValueError(f"{page}: more headings than toc tokens near {line!r}")
            level, anchor, name = toc[toc_index]
            toc_index += 1
            if level != len(heading.group(1)):
                raise ValueError(f"{page}: heading level mismatch at {line!r} (toc says {level})")
            text = scrub(name).strip()
            if level == 1:
                page_title = text or page_title
            elif level <= 3:
                sections.append(Section(level, text, anchor))
            else:
                current.lines.append(f"{text}:")
            continue
        # An admonition or content tab opens a block whose body is indented four
        # spaces deeper than its opener; the body is de-indented to plain prose.
        admonition = ADMONITION_RE.match(line.lstrip(" "))
        if admonition:
            kind = admonition.group("kind").replace("-", " ").capitalize()
            title_text = clean_inline(admonition.group("title") or "")
            current.lines.append(f"{kind}: {title_text}" if title_text else f"{kind}:")
            stack.append(indent + 4)
            continue
        tab = TAB_RE.match(line.lstrip(" "))
        if tab:
            current.lines.append(f"[{clean_inline(tab.group('title'))}]")
            stack.append(indent + 4)
            continue
        current.lines.append(clean_inline(line))
    if toc_index != len(toc):
        raise ValueError(f"{page}: {len(toc) - toc_index} toc heading(s) not found in the source")
    return page_title, sections


def paragraphs(text: str) -> list[str]:
    """Blank-line separated blocks; a fenced code block is never split."""
    out: list[str] = []
    current: list[str] = []
    in_fence = False
    for line in text.split("\n"):
        if FENCE_RE.match(line.strip()):
            in_fence = not in_fence
        if not line.strip() and not in_fence:
            if current:
                out.append("\n".join(current).strip("\n"))
                current = []
            continue
        current.append(line)
    if current:
        out.append("\n".join(current).strip("\n"))
    return [p for p in out if p.strip()]


def pack(text: str) -> list[str]:
    """Greedy paragraph packing to ~TARGET_CHARS, hard cap HARD_CHARS."""
    out: list[str] = []
    current = ""
    for para in paragraphs(text):
        while len(para) > HARD_CHARS:
            cut = para.rfind("\n", 0, TARGET_CHARS)
            if cut < TARGET_CHARS // 2:
                cut = para.rfind(" ", 0, TARGET_CHARS)
            if cut < TARGET_CHARS // 2:
                cut = TARGET_CHARS
            if current:
                out.append(current)
                current = ""
            out.append(para[:cut].strip())
            para = para[cut:].strip()
        if not current:
            current = para
        elif len(current) + len(para) + 2 <= TARGET_CHARS:
            current = f"{current}\n\n{para}"
        else:
            out.append(current)
            current = para
    if current:
        out.append(current)
    return out


def collapse_blank_runs(lines: list[str]) -> str:
    text = "\n".join(lines)
    text = re.sub(r"[ \t]+\n", "\n", text)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


# --------------------------------------------------------------------------- #
# Build.
# --------------------------------------------------------------------------- #
@dataclass
class BuildResult:
    files: dict[str, bytes]
    warnings: list[str]
    chunk_ids: dict[str, str]          # id -> sha of its record (for --check diffs)
    errors: list[str] = field(default_factory=list)


def same_bytes(committed: bytes, generated: bytes) -> bool:
    """Committed file equals the generated bytes, ignoring CRLF line endings that a
    ``core.autocrlf`` checkout introduces (JSON strings cannot hold a raw newline, so
    line endings never change content; the backend loader hashes the same way)."""
    return committed.replace(b"\r\n", b"\n") == generated


def _dump(obj: Any) -> bytes:
    # One key per line keeps diffs local to the chunk that changed.
    return (json.dumps(obj, ensure_ascii=False, indent=1) + "\n").encode("utf-8")


def build() -> BuildResult:
    import markdown
    from mkdocs.utils import meta as mkdocs_meta

    version = product_version()
    line = docs_line(version)
    config = load_mkdocs_config()
    md = markdown.Markdown(
        extensions=config["markdown_extensions"],
        extension_configs=config["mdx_configs"],
    )
    console_path = OUT_DIR / "console_map.json"
    if not console_path.is_file():
        raise SystemExit(
            "build_app_knowledge: backend/app/knowledge/console_map.json is missing; "
            "run `npm run gen:console-map` in webui/ first"
        )
    console_bytes = console_path.read_bytes().replace(b"\r\n", b"\n")
    console_map = json.loads(console_bytes)
    resolver = ConsoleResolver(list(console_map.get("targets") or []))
    target_ids = {t["id"] for t in console_map.get("targets") or []}

    warnings: list[str] = []
    errors: list[str] = []
    pages: dict[str, dict[str, Any]] = {}
    chunks: list[dict[str, Any]] = []
    previous_cwd = Path.cwd()
    os.chdir(ROOT)  # pymdownx.snippets resolves relative to the working directory
    try:
        for page, crumb in nav_pages(config["nav"]):
            tier = tier_for(page, version)
            if tier is None:
                continue
            source = (DOCS / page).read_text(encoding="utf-8")
            body, meta = mkdocs_meta.get_data(source)
            md.reset()
            md.convert(body)
            toc = flat_toc(getattr(md, "toc_tokens", []))
            title, sections = split_sections(page, body, toc, scrub(str(meta.get("title") or crumb[-1])))
            pages[page] = {
                "title": title,
                "description": scrub(clean_inline(str(meta.get("description") or ""))),
                "nav": [scrub(c) for c in crumb],
                "path": url_path(page),
                "tier": tier,
            }
            stem = page[:-3]
            for section in sections:
                if norm_label(section.heading) in SKIPPED_HEADINGS:
                    continue
                text = scrub(collapse_blank_runs(section.lines))
                if len(text) < MIN_SECTION_CHARS:
                    continue
                console: list[str] = []
                for match in BREADCRUMB_RE.finditer(text):
                    segments = [s.strip() for s in match.group(1).split("→")]
                    target, complete = resolver.resolve(segments)
                    if target is None:
                        crumb_text = " → ".join(segments)
                        message = f"{page}#{section.anchor}: unresolved console breadcrumb {match.group(0)}"
                        if crumb_text in UNRESOLVED_BREADCRUMB_ALLOWLIST:
                            warnings.append(message)
                        else:
                            errors.append(message)
                        continue
                    if not complete:
                        warnings.append(
                            f"{page}#{section.anchor}: breadcrumb {match.group(0)} resolved only to {target}"
                        )
                    if target not in console:
                        console.append(target)
                for index, part in enumerate(pack(text)):
                    chunks.append({
                        "id": f"{stem}#{section.anchor}:{index}",
                        "page": page,
                        "anchor": section.anchor,
                        "heading": section.heading,
                        "text": part,
                        "console": console,
                    })
    finally:
        os.chdir(previous_cwd)

    # Topic doc refs ("Ask about this") must land on a real page section.
    known_refs = {f"{pages[c['page']]['path']}#{c['anchor']}" for c in chunks if c["anchor"]}
    for topic in console_map.get("topics") or []:
        for ref in topic.get("docs") or []:
            if ref not in known_refs:
                raise SystemExit(f"build_app_knowledge: topic {topic.get('id')} cites unknown docs ref {ref!r}")
        if topic.get("console") and topic["console"] not in target_ids:
            raise SystemExit(f"build_app_knowledge: topic {topic.get('id')} names unknown console target")

    corpus = {
        "schema": SCHEMA,
        "product_version": version,
        "docs_version": line,
        "pages": pages,
        "chunks": chunks,
    }
    aliases = {"schema": SCHEMA, "aliases": {k: ALIASES[k] for k in sorted(ALIASES)}}
    files = {
        "app_docs.json": _dump(corpus),
        "aliases.json": _dump(aliases),
    }
    manifest = {
        "schema": SCHEMA,
        "generator": GENERATOR,
        "product_version": version,
        "docs_version": line,
        "counts": {"pages": len(pages), "chunks": len(chunks)},
        "sha256": {
            name: hashlib.sha256(data).hexdigest()
            for name, data in sorted({**files, "console_map.json": console_bytes}.items())
        },
    }
    files["manifest.json"] = _dump(manifest)
    chunk_ids = {
        c["id"]: hashlib.sha256(json.dumps(c, sort_keys=True).encode()).hexdigest() for c in chunks
    }
    return BuildResult(files=files, warnings=warnings, chunk_ids=chunk_ids, errors=errors)


def _committed_chunk_ids() -> dict[str, str]:
    try:
        corpus = json.loads((OUT_DIR / "app_docs.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return {
        c.get("id", ""): hashlib.sha256(json.dumps(c, sort_keys=True).encode()).hexdigest()
        for c in corpus.get("chunks") or []
        if isinstance(c, dict)
    }


def main(argv: list[str] | None = None) -> int:
    arguments = list(sys.argv[1:] if argv is None else argv)
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--check", action="store_true", help="fail when the committed corpus is stale")
    parser.add_argument("--quiet", action="store_true", help="suppress breadcrumb warnings")
    options = parser.parse_args(arguments)
    _ensure_toolchain(arguments)

    result = build()
    if not options.quiet:
        for warning in result.warnings:
            print(f"warning: {warning}", file=sys.stderr)
    if result.errors:
        for error in result.errors:
            print(f"error: {error}", file=sys.stderr)
        print(
            "Fix the breadcrumb to name a real console destination, or add it to "
            "UNRESOLVED_BREADCRUMB_ALLOWLIST when it deliberately is not one.",
            file=sys.stderr,
        )
        return 1

    if options.check:
        stale = [
            name for name, data in result.files.items()
            if not (OUT_DIR / name).is_file() or not same_bytes((OUT_DIR / name).read_bytes(), data)
        ]
        if not stale:
            print(f"App knowledge corpus is current ({len(result.chunk_ids)} chunks).")
            return 0
        committed = _committed_chunk_ids()
        added = sorted(set(result.chunk_ids) - set(committed))
        removed = sorted(set(committed) - set(result.chunk_ids))
        changed = sorted(k for k in set(result.chunk_ids) & set(committed) if result.chunk_ids[k] != committed[k])
        print("App knowledge corpus is stale: " + ", ".join(sorted(stale)), file=sys.stderr)
        for label, ids in (("added", added), ("removed", removed), ("changed", changed)):
            if ids:
                shown = ", ".join(ids[:20]) + (" …" if len(ids) > 20 else "")
                print(f"  {label} ({len(ids)}): {shown}", file=sys.stderr)
        print("Run `python scripts/build_app_knowledge.py` and commit the result.", file=sys.stderr)
        return 1

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for name, data in result.files.items():
        path = OUT_DIR / name
        if not path.is_file() or path.read_bytes() != data:
            path.write_bytes(data)
    print(f"Wrote app knowledge corpus: {len(result.chunk_ids)} chunks -> {OUT_DIR.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
