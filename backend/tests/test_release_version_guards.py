"""Release guards in ``scripts/check_version.py`` and the 0.2.0 release contract.

The gate runs on every ref. On ``main``, on a ``v*`` tag and on a pull request into
``main`` (``GITHUB_BASE_REF == "main"``, which GitHub sets on ``pull_request`` events)
it also requires the records a release carries: an ``[Unreleased]`` section that reads
exactly ``No changes yet.`` and a GitHub Release body (the release-commit marker plus
``docs/releases/<VERSION>.md``) of at most 100,000 characters. Every shipping
Dockerfile must declare the Apache-2.0 license label on every ref.

The gate resolves its ROOT from its own path, so each case runs it from a throwaway
mirror whose files are links to the real tree. A planted file is first turned into a
real copy (and each directory above it into a real directory of links), so a test can
never write through a link into the checkout.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
import tomllib
from pathlib import Path

import pytest
import yaml

from app import __version__


ROOT = Path(__file__).resolve().parents[2]
VERSION = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
RELEASE_CONTEXT_ENV = ("TLSOC_SOURCE_REF", "TLSOC_RELEASE_CHANNEL", "GITHUB_BASE_REF")


def _mirror(tmp_path: Path) -> Path:
    mirror = tmp_path / "mirror"
    mirror.mkdir()
    for entry in ROOT.iterdir():
        if entry.name == "scripts":
            shutil.copytree(entry, mirror / entry.name, symlinks=True)
        else:
            (mirror / entry.name).symlink_to(entry)
    return mirror


def _materialize(mirror: Path, relative: str) -> Path:
    """Make ``relative`` a real, writable file in the mirror, never a link."""

    current = mirror
    parts = Path(relative).parts
    for part in parts[:-1]:
        current = current / part
        if current.is_symlink():
            target = current.resolve()
            current.unlink()
            current.mkdir()
            for child in target.iterdir():
                (current / child.name).symlink_to(child)
    planted = current / parts[-1]
    source = planted.resolve()
    if planted.is_symlink():
        planted.unlink()
        shutil.copyfile(source, planted)
    assert not planted.is_symlink()
    return planted


def _run(mirror: Path, **context: str) -> subprocess.CompletedProcess[str]:
    env = {key: value for key, value in os.environ.items() if key not in RELEASE_CONTEXT_ENV}
    env.update(context)
    return subprocess.run(
        [sys.executable, str(mirror / "scripts" / "check_version.py")],
        capture_output=True,
        text=True,
        env=env,
    )


def _empty_unreleased(mirror: Path) -> None:
    changelog = _materialize(mirror, "CHANGELOG.md")
    source = changelog.read_text(encoding="utf-8")
    emptied, count = re.subn(
        r"^## \[Unreleased\]\s*$\n.*?(?=^## )",
        "## [Unreleased]\n\nNo changes yet.\n\n",
        source,
        count=1,
        flags=re.MULTILINE | re.DOTALL,
    )
    assert count == 1
    changelog.write_text(emptied, encoding="utf-8")


MAIN = {"TLSOC_SOURCE_REF": "refs/heads/main", "TLSOC_RELEASE_CHANNEL": "stable"}
TAG = {"TLSOC_SOURCE_REF": f"refs/tags/v{VERSION}", "TLSOC_RELEASE_CHANNEL": "stable"}
PR_INTO_MAIN = {
    "TLSOC_SOURCE_REF": "refs/pull/7/merge",
    "TLSOC_RELEASE_CHANNEL": "testing",
    "GITHUB_BASE_REF": "main",
}
PR_INTO_TESTING = {
    "TLSOC_SOURCE_REF": "refs/pull/7/merge",
    "TLSOC_RELEASE_CHANNEL": "testing",
    "GITHUB_BASE_REF": "Testing",
}
UNRELEASED_FAILURE = "the [Unreleased] section must read exactly 'No changes yet.'"


def test_the_version_is_0_2_0_on_documentation_line_0_2() -> None:
    assert VERSION == "0.2.0" == __version__
    mkdocs = (ROOT / "mkdocs.yml").read_text(encoding="utf-8")
    assert 'product_version: "0.2.0"' in mkdocs
    assert 'docs_version: "0.2"' in mkdocs


def test_the_branch_passes(tmp_path: Path) -> None:
    result = _run(_mirror(tmp_path))
    assert result.returncode == 0, result.stderr


@pytest.mark.parametrize(
    "context", [MAIN, TAG, PR_INTO_MAIN], ids=["main", "tag", "pull-request-into-main"]
)
def test_a_release_ref_refuses_notes_left_under_unreleased(
    tmp_path: Path, context: dict[str, str]
) -> None:
    result = _run(_mirror(tmp_path), **context)
    assert result.returncode == 1
    assert UNRELEASED_FAILURE in result.stderr


@pytest.mark.parametrize(
    "context", [MAIN, TAG, PR_INTO_MAIN], ids=["main", "tag", "pull-request-into-main"]
)
def test_a_release_ref_passes_with_an_empty_unreleased_section(
    tmp_path: Path, context: dict[str, str]
) -> None:
    mirror = _mirror(tmp_path)
    _empty_unreleased(mirror)
    result = _run(mirror, **context)
    assert result.returncode == 0, result.stderr


def test_a_pull_request_into_testing_is_not_a_release_ref(tmp_path: Path) -> None:
    result = _run(_mirror(tmp_path), **PR_INTO_TESTING)
    assert result.returncode == 0, result.stderr


def test_an_oversize_release_page_fails_only_on_a_release_ref(tmp_path: Path) -> None:
    mirror = _mirror(tmp_path)
    _empty_unreleased(mirror)
    page = _materialize(mirror, f"docs/releases/{VERSION}.md")
    source = page.read_text(encoding="utf-8")
    page.write_text(source + "\n" + ("x" * 99 + "\n") * 1_000, encoding="utf-8")

    on_main = _run(mirror, **MAIN)
    assert on_main.returncode == 1
    assert f"docs/releases/{VERSION}.md: the GitHub Release body would be" in on_main.stderr
    assert "keep it at most 100,000" in on_main.stderr
    assert _run(mirror).returncode == 0


def test_the_release_body_budget_counts_the_commit_marker(tmp_path: Path) -> None:
    mirror = _mirror(tmp_path)
    _empty_unreleased(mirror)
    page = _materialize(mirror, f"docs/releases/{VERSION}.md")
    marker = len("<!-- agentic-soc-release-commit:" + "0" * 40 + " -->\n\n")
    source = page.read_text(encoding="utf-8")
    page.write_text(source + "x" * (100_000 - marker - len(source)), encoding="utf-8")
    assert _run(mirror, **MAIN).returncode == 0
    page.write_text(source + "x" * (100_000 - marker - len(source) + 1), encoding="utf-8")
    assert _run(mirror, **MAIN).returncode == 1


@pytest.mark.parametrize(
    "dockerfile", ["backend/Dockerfile", "webui/Dockerfile", "updater/Dockerfile"]
)
def test_every_shipping_dockerfile_keeps_the_license_label(
    tmp_path: Path, dockerfile: str
) -> None:
    mirror = _mirror(tmp_path)
    planted = _materialize(mirror, dockerfile)
    source = planted.read_text(encoding="utf-8")
    label = 'org.opencontainers.image.licenses="Apache-2.0"'
    assert source.count(label) == 1
    planted.write_text(source.replace(label, 'org.opencontainers.image.vendor="x"'), encoding="utf-8")
    result = _run(mirror)
    assert result.returncode == 1
    assert f"{dockerfile}: missing license label" in result.stderr


def test_the_plan_builder_admits_the_next_minor_line() -> None:
    source = (ROOT / "scripts" / "build_upgrade_plan.py").read_text(encoding="utf-8")
    assert 'parser.add_argument("--max-version-exclusive", default="0.3.0")' in source
    assert 'parser.add_argument("--min-version", default="0.1.1")' in source


def test_dependabot_follows_the_promotion_direction() -> None:
    """D13: every block targets Testing; the Python base image keeps its 3.11 line."""
    config = yaml.safe_load((ROOT / ".github" / "dependabot.yml").read_text(encoding="utf-8"))
    updates = config["updates"]
    assert len(updates) == 4
    assert all(update["target-branch"] == "Testing" for update in updates)
    python_ignore = {
        "dependency-name": "python",
        "update-types": ["version-update:semver-major", "version-update:semver-minor"],
    }
    for update in updates:
        if update["package-ecosystem"] == "docker" and update["directory"] in {"/backend", "/webui"}:
            assert python_ignore in update.get("ignore", []), update["directory"]


def test_the_forward_ported_action_pins_match_main() -> None:
    """D13: the four main-only Dependabot bumps, with the same commit pins."""
    workflows = {
        name: (ROOT / ".github" / "workflows" / name).read_text(encoding="utf-8")
        for name in ("ci.yml", "docs.yml")
    }
    expected = {
        "actions/upload-pages-artifact@fc324d3547104276b827a68afc52ff2a11cc49c9 # v5.0.0": 1,
        "actions/configure-pages@45bfe0192ca1faeb007ade9deae92b16b8254a0d # v6.0.0": 1,
        "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1": 3,
        "actions/setup-go@b7ad1dad31e06c5925ef5d2fc7ad053ef454303e # v7.0.0": 1,
    }
    joined = "\n".join(workflows.values())
    for pin, count in expected.items():
        assert joined.count(pin) == count, pin
    for retired in (
        "actions/upload-pages-artifact@7b1f4a764d45c48632c6b24a0339c27f5614fb0b",
        "actions/configure-pages@983d7736d9b0ae728b81ab479565c72886d7745b",
        "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
        "actions/setup-go@924ae3a1cded613372ab5595356fb5720e22ba16",
    ):
        assert retired not in joined, retired


def test_the_repository_identity_is_the_new_name_everywhere_it_is_a_default() -> None:
    """D2: every live default names ARYDESTROYER/Kavach-AgenticSOC."""
    new = "ARYDESTROYER/Kavach-AgenticSOC"
    assert f'required("UPDATE_TRUSTED_REPOSITORY", "{new}")' in (
        ROOT / "updater" / "agentic_soc_updater" / "__main__.py"
    ).read_text(encoding="utf-8")
    assert f"--env UPDATE_TRUSTED_REPOSITORY={new} " in (
        ROOT / ".github" / "workflows" / "ci.yml"
    ).read_text(encoding="utf-8")
    assert f"AGENTIC_SOC_UPDATE_REPOSITORY={new}\n" in (ROOT / ".env.example").read_text(
        encoding="utf-8"
    )
    mkdocs = (ROOT / "mkdocs.yml").read_text(encoding="utf-8")
    assert '"https://arydestroyer.github.io/Kavach-AgenticSOC/"' in mkdocs
    assert '"https://arydestroyer.github.io/Kavach-AgenticSOC/stable/"' in mkdocs
    assert f"repo_url: https://github.com/{new}\n" in mkdocs
    assert f"repo_name: {new}\n" in mkdocs
    for template in sorted((ROOT / ".github" / "ISSUE_TEMPLATE").glob("*.yml")):
        assert "Agentic-Kibana" not in template.read_text(encoding="utf-8"), template.name
    # The frozen Compose base is byte-identical, so it still names the former default.
    base = (ROOT / "deploy" / "docker-compose.agnostic.yml").read_text(encoding="utf-8")
    assert "${AGENTIC_SOC_UPDATE_REPOSITORY:-ARYDESTROYER/Agentic-Kibana}" in base


def test_the_backend_package_declares_apache_2() -> None:
    data = tomllib.loads((ROOT / "backend" / "pyproject.toml").read_text(encoding="utf-8"))
    assert data["project"]["license"] == "Apache-2.0"
    assert data["project"]["version"] == VERSION
