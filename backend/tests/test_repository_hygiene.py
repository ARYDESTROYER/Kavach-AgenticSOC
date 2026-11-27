"""Offline source-tree hygiene checks.

Regression for the Round 12 final review: a downloaded third-party wheel (a ruff
build, about 10 MB) was committed under ``backend/``. Wheels are never part of the
supported source tree; CI builds the backend wheel into ``dist/`` and tool downloads
belong in a session scratchpad. These checks keep that from happening again.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[2]


def _git(*args: str) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(
        ["git", "-C", str(ROOT), *args],
        capture_output=True,
        check=False,
        timeout=30,
    )


def _require_git_checkout() -> None:
    if shutil.which("git") is None:
        pytest.skip("git is not installed")
    probe = _git("rev-parse", "--is-inside-work-tree")
    if probe.returncode != 0 or probe.stdout.strip() != b"true":
        pytest.skip("not running from a git checkout")


def test_gitignore_ignores_wheel_files() -> None:
    lines = {
        line.strip()
        for line in (ROOT / ".gitignore").read_text(encoding="utf-8").splitlines()
    }
    assert "*.whl" in lines
    # A later negation would silently re-admit wheels.
    assert not any(line.startswith("!") and line.endswith(".whl") for line in lines)


@pytest.mark.parametrize(
    "path",
    [
        "backend/ruff-0.17.0-py3-none-manylinux_2_17_x86_64.manylinux2014_x86_64.whl",
        "scratch.whl",
        "webui/tool-1.0-py3-none-any.whl",
    ],
)
def test_git_treats_wheel_downloads_as_ignored(path: str) -> None:
    _require_git_checkout()
    result = _git("check-ignore", "-q", "--no-index", path)
    assert result.returncode == 0, f"{path} is not ignored by .gitignore"


def test_no_wheel_files_are_tracked() -> None:
    _require_git_checkout()
    listed = _git("ls-files", "-z", "--", "*.whl")
    assert listed.returncode == 0, listed.stderr.decode("utf-8", "replace")
    tracked = [
        name
        for name in listed.stdout.decode("utf-8", "replace").split("\0")
        # A deletion that is not yet staged still shows in the index; only files
        # that are both tracked and present in the working tree count.
        if name and (ROOT / name).exists()
    ]
    assert tracked == [], f"wheel files must not be tracked: {tracked}"
