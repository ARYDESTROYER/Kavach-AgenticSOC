#!/usr/bin/env python3
"""Build the version-matched MkDocs Help Center for Agentic SOC.

The generated tree is intentionally disposable.  It is copied into Vite's
``public/docs`` directory for local development and Console builds, then ignored
by Git.  The installed documentation line is derived from the canonical product
``VERSION`` (major.minor), so an application image and its manual cannot drift.
"""

from __future__ import annotations

import argparse
import html
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from collections.abc import Mapping
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = ROOT / "webui" / "public" / "docs"
#: Earlier installed documentation lines. Each page address of these lines gets a
#: redirect page to the same page of the current line, so stored chat citations,
#: report links and bookmarks keep working. Every later minor release extends it.
LEGACY_DOC_LINES = ("0.1",)
#: The page that stored chat citations name with a fragment (``#sources``). The
#: bundle check requires its redirect page whenever the current tree has the page.
ANCHORED_STUB_PAGE = "analyst/chat/"
#: Folders under ``docs/`` that are generator input, not Help Center files. Each is in
#: the ``exclude_docs`` block of ``mkdocs.yml``; the bundle check refuses a tree that
#: still carries one (the curated What's new notes, ``docs/releases/notes/*.json``).
NON_BUNDLED_DOC_DIRS = ("releases/notes",)
SEMVER = re.compile(
    r"^(0|[1-9]\d*)\."
    r"(0|[1-9]\d*)\."
    r"(0|[1-9]\d*)"
    r"(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?"
    r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$"
)


def product_version() -> str:
    """Return the canonical SemVer from the root VERSION file."""

    value = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
    if not SEMVER.fullmatch(value):
        raise ValueError(f"VERSION is not valid SemVer: {value!r}")
    return value


def documentation_version(version: str) -> str:
    """Map a product SemVer to its stable documentation line (major.minor)."""

    match = SEMVER.fullmatch(version)
    if not match:
        raise ValueError(f"product version is not valid SemVer: {version!r}")
    return f"{match.group(1)}.{match.group(2)}"


def release_channel(environment: Mapping[str, str] = os.environ) -> str:
    """Normalize build metadata without ever promoting an unknown value."""

    configured = (
        environment.get("TLSOC_DOCS_CHANNEL")
        or environment.get("TLSOC_RELEASE_CHANNEL")
        or "testing"
    ).strip().lower()
    return "Stable" if configured == "stable" else "Testing"


def _fragment_script(target: str) -> str:
    """The inline script that redirects and keeps the URL fragment.

    The target is JSON-encoded, with ``<`` escaped so it can never close the script.
    """

    encoded = json.dumps(target).replace("<", "\\u003c")
    return f"<script>location.replace({encoded} + location.hash)</script>"


def _redirect_page(target: str, label: str, *, keep_fragment: bool = False) -> str:
    safe_target = html.escape(target, quote=True)
    safe_label = html.escape(label)
    # A meta refresh drops the fragment, so a page that must keep it redirects from
    # a script first; the meta refresh stays the no-script fallback.
    script = f"\n    {_fragment_script(target)}" if keep_fragment else ""
    return f"""<!doctype html>
<html lang=\"en\">
  <head>
    <meta charset=\"utf-8\">
    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">{script}
    <meta http-equiv=\"refresh\" content=\"0; url={safe_target}\">
    <link rel=\"canonical\" href=\"{safe_target}\">
    <title>{safe_label}</title>
  </head>
  <body>
    <p><a href=\"{safe_target}\">Open {safe_label}</a></p>
  </body>
</html>
"""


def write_bundle_metadata(
    output: Path,
    *,
    version: str,
    docs_version: str,
    channel: str,
) -> None:
    """Add deterministic installed-version metadata and landing aliases."""

    canonical_path = f"/docs/{docs_version}/"
    manifest = {
        "schemaVersion": 1,
        "productVersion": version,
        "documentationVersion": docs_version,
        "releaseChannel": channel,
        "canonicalPath": canonical_path,
        "installedAliases": ["/docs/", "/docs/installed/"],
    }
    (output / "manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    (output / "index.html").write_text(
        _redirect_page(canonical_path, f"Agentic SOC {docs_version} documentation"),
        encoding="utf-8",
    )
    installed = output / "installed"
    installed.mkdir(parents=True, exist_ok=True)
    (installed / "index.html").write_text(
        _redirect_page(canonical_path, f"installed Agentic SOC {docs_version} documentation"),
        encoding="utf-8",
    )


def current_pages(version_root: Path) -> list[str]:
    """Every page address of the built tree, relative and ending in ``/``.

    MkDocs writes directory URLs, so a page is a directory with an ``index.html``;
    the home page is the empty string.
    """

    pages: list[str] = []
    for index in sorted(version_root.rglob("index.html")):
        relative = index.parent.relative_to(version_root).as_posix()
        pages.append("" if relative == "." else f"{relative}/")
    return pages


def legacy_lines(docs_version: str) -> tuple[str, ...]:
    """The earlier lines that redirect into ``docs_version`` (never the line itself)."""

    return tuple(line for line in LEGACY_DOC_LINES if line != docs_version)


def write_legacy_redirects(output: Path, *, docs_version: str) -> int:
    """Write ``/docs/<old>/<page>/index.html`` for every current page and old line."""

    pages = current_pages(output / docs_version)
    written = 0
    for line in legacy_lines(docs_version):
        for page in pages:
            stub = output / line / page / "index.html"
            stub.parent.mkdir(parents=True, exist_ok=True)
            stub.write_text(
                _redirect_page(
                    f"/docs/{docs_version}/{page}",
                    f"Agentic SOC {docs_version} documentation",
                    keep_fragment=True,
                ),
                encoding="utf-8",
            )
            written += 1
    return written


def validate_legacy_redirects(output: Path, *, docs_version: str) -> None:
    """Every current page has a fragment-keeping redirect in every earlier line."""

    pages = current_pages(output / docs_version)
    problems: list[str] = []
    for line in legacy_lines(docs_version):
        if ANCHORED_STUB_PAGE in pages and not (
            output / line / ANCHORED_STUB_PAGE / "index.html"
        ).is_file():
            problems.append(f"/docs/{line}/{ANCHORED_STUB_PAGE} (anchored citation page)")
        for page in pages:
            stub = output / line / page / "index.html"
            target = f"/docs/{docs_version}/{page}"
            if not stub.is_file():
                problems.append(f"/docs/{line}/{page} is missing")
                continue
            source = stub.read_text(encoding="utf-8")
            safe_target = html.escape(target, quote=True)
            script = _fragment_script(target)
            refresh = f'<meta http-equiv="refresh" content="0; url={safe_target}">'
            if (
                script not in source
                or refresh not in source
                or f'<link rel="canonical" href="{safe_target}">' not in source
                or source.index(script) > source.index(refresh)
            ):
                problems.append(f"/docs/{line}/{page} does not redirect to {target}")
    if problems:
        raise RuntimeError(
            "documentation redirect pages are incomplete: " + ", ".join(problems[:10])
        )


def validate_bundle(
    output: Path,
    *,
    version: str,
    docs_version: str,
    channel: str | None = None,
) -> None:
    """Fail when the generated artifact does not match the installed release."""

    required = (
        output / "index.html",
        output / "installed" / "index.html",
        output / "manifest.json",
        output / docs_version / "index.html",
        output / docs_version / "search" / "search_index.json",
    )
    missing = [str(path) for path in required if not path.is_file()]
    if missing:
        raise RuntimeError("documentation bundle is incomplete: " + ", ".join(missing))

    canonical_index = (output / docs_version / "index.html").read_text(encoding="utf-8")
    if 'name="generator" content="mkdocs-' not in canonical_index:
        raise RuntimeError("documentation landing page is not a generated MkDocs artifact")

    manifest = json.loads((output / "manifest.json").read_text(encoding="utf-8"))
    expected = {
        "productVersion": version,
        "documentationVersion": docs_version,
        "canonicalPath": f"/docs/{docs_version}/",
    }
    if channel is not None:
        expected["releaseChannel"] = channel
    for key, value in expected.items():
        if manifest.get(key) != value:
            raise RuntimeError(
                f"documentation manifest {key} mismatch: "
                f"expected {value!r}, found {manifest.get(key)!r}"
            )
    leaked = [
        f"/docs/{docs_version}/{folder}/"
        for folder in NON_BUNDLED_DOC_DIRS
        if (output / docs_version / folder).exists()
    ]
    if leaked:
        raise RuntimeError(
            "documentation bundle carries generator input that mkdocs.yml excludes: "
            + ", ".join(leaked)
        )
    validate_legacy_redirects(output, docs_version=docs_version)


def _validated_output(path: Path) -> Path:
    resolved = path.expanduser().resolve()
    forbidden = {Path("/").resolve(), ROOT.resolve(), ROOT.parent.resolve()}
    if resolved in forbidden:
        raise ValueError(f"refusing unsafe documentation output directory: {resolved}")
    return resolved


def build(output: Path) -> None:
    version = product_version()
    docs_version = documentation_version(version)
    channel = release_channel()
    configured_version = os.environ.get("TLSOC_VERSION", "").strip()
    if (
        configured_version
        and configured_version.lower() != "unknown"
        and configured_version != version
    ):
        raise RuntimeError(
            f"TLSOC_VERSION={configured_version!r} does not match VERSION {version!r}"
        )

    output = _validated_output(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="tlsoc-docs-", dir=output.parent) as raw_temp:
        staged_root = Path(raw_temp) / "docs"
        version_root = staged_root / docs_version
        environment = os.environ.copy()
        environment.update(
            {
                "TLSOC_DOCS_CHANNEL": channel,
                # A bundled, same-origin site cannot know its deployment hostname.
                # Empty site_url keeps generated navigation relative instead of
                # publishing a false localhost or GitHub canonical URL.
                "TLSOC_DOCS_SITE_URL": "",
                "TLSOC_DOCS_EDIT_URI": (
                    "edit/main/docs/" if channel == "Stable" else "edit/Testing/docs/"
                ),
                "TLSOC_DOCS_STABLE_URL": "/docs/installed/",
            }
        )
        command = [
            sys.executable,
            "-m",
            "mkdocs",
            "build",
            "--strict",
            "--config-file",
            str(ROOT / "mkdocs.yml"),
            "--site-dir",
            str(version_root),
        ]
        try:
            subprocess.run(command, cwd=ROOT, env=environment, check=True)
        except subprocess.CalledProcessError as exc:
            raise RuntimeError(
                f"MkDocs bundle build failed with status {exc.returncode}"
            ) from exc

        write_bundle_metadata(
            staged_root,
            version=version,
            docs_version=docs_version,
            channel=channel,
        )
        write_legacy_redirects(staged_root, docs_version=docs_version)
        validate_bundle(
            staged_root,
            version=version,
            docs_version=docs_version,
            channel=channel,
        )

        backup = output.with_name(f".{output.name}.previous")
        if backup.exists():
            shutil.rmtree(backup)
        if output.exists():
            output.rename(backup)
        try:
            shutil.move(str(staged_root), str(output))
        except BaseException:
            if backup.exists() and not output.exists():
                backup.rename(output)
            raise
        finally:
            if backup.exists():
                shutil.rmtree(backup)

    print(
        f"Bundled Agentic SOC {version} documentation ({channel}) at "
        f"{output} -> /docs/{docs_version}/"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output",
        type=Path,
        default=DEFAULT_OUTPUT,
        help=f"generated docs root (default: {DEFAULT_OUTPUT})",
    )
    parser.add_argument(
        "--check-only",
        action="store_true",
        help="validate an existing bundle instead of rebuilding it",
    )
    args = parser.parse_args()
    try:
        version = product_version()
        docs_version = documentation_version(version)
        if args.check_only:
            validate_bundle(
                _validated_output(args.output),
                version=version,
                docs_version=docs_version,
                channel=release_channel(),
            )
            print(f"Documentation bundle is consistent: app {version}; docs {docs_version}")
        else:
            build(args.output)
    except (OSError, RuntimeError, ValueError, json.JSONDecodeError) as exc:
        print(f"Documentation bundle failed: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
