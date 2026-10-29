"""Offline packaging and backend-image contract smoke tests.

Round 14 (SPEC §4.10.16, §7.3 WP-A8c): the retired procedure files (the
``backend/playbooks/`` package and the plain-text ``app/runbooks/*.md`` reference
runbooks) no longer ship. The 12 built-in runbooks under ``app/runbooks/library/``
ship in the wheel, the sdist and the image instead.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
import tarfile
import tomllib
import zipfile
from pathlib import Path

from app.connectors.registry import get_registry
from app.engine.runbook_model import BUILTIN_RUNBOOK_IDS

from tests.test_runbook_removals import has_source


BACKEND = Path(__file__).resolve().parents[1]
REPO = BACKEND.parent
#: The wheel paths of the 12 built-in runbooks.
LIBRARY_FILES = frozenset(f"app/runbooks/library/{rid}.md" for rid in BUILTIN_RUNBOOK_IDS)
#: The retired procedure files (SPEC §4.10.16); none of them may ship again.
RETIRED_FILES = (
    "playbooks/brute_force_login.md",
    "playbooks/README.md",
    "app/runbooks/brute_force.md",
    "app/runbooks/web_attack.md",
)


def _retired_names(names: set[str]) -> list[str]:
    """Wheel/sdist members that belong to the retired procedure layout."""
    return sorted(
        name for name in names
        if name.startswith(("playbooks/", "app/playbooks/"))
        or (name.startswith("app/runbooks/") and name.count("/") == 2 and name.endswith(".md"))
    )


def _requirement_names(path: Path) -> set[str]:
    names: set[str] = set()
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line or line.startswith("-"):
            continue
        name = re.split(r"[<>=!~\[]", line, maxsplit=1)[0]
        names.add(re.sub(r"[-_.]+", "-", name).lower())
    return names


def test_all_manifest_connector_clients_ship_in_full_requirement_set() -> None:
    """The default full image must import every client its registry advertises."""
    required = {
        re.sub(r"[-_.]+", "-", dep).lower()
        for manifest in get_registry().manifests()
        for dep in manifest.requires_pip
    }
    available = _requirement_names(BACKEND / "requirements.txt") | _requirement_names(
        BACKEND / "requirements-connectors.txt"
    )
    assert required <= available, f"connector clients missing from full image: {required - available}"


def test_dockerfile_is_non_root_complete_and_explicitly_tiered() -> None:
    dockerfile = (BACKEND / "Dockerfile").read_text(encoding="utf-8")
    runtime_base = re.compile(
        r"^FROM python:3\.11\.15-slim-bookworm@sha256:[0-9a-f]{64} AS runtime-base$",
        flags=re.MULTILINE,
    )
    assert runtime_base.search(dockerfile) is not None
    assert "FROM runtime-base AS core" in dockerfile
    assert "FROM runtime-base AS full" in dockerfile
    # The built-in runbook library ships inside the package, so copying ``app/``
    # carries it; the retired sibling ``playbooks/`` directory is no longer copied.
    assert "COPY --chown=tlsoc:tlsoc app ./app" in dockerfile
    assert "playbooks" not in dockerfile
    assert "requirements-connectors.txt" in dockerfile
    assert dockerfile.rstrip().endswith("USER 10001:10001")
    assert "org.opencontainers.image.source" in dockerfile
    assert "org.opencontainers.image.licenses" not in dockerfile
    assert "/api/health/ready" in dockerfile


def test_docker_context_keeps_runtime_data() -> None:
    ignored = {
        line.strip() for line in (BACKEND / ".dockerignore").read_text(encoding="utf-8").splitlines()
    }
    assert "*.md" not in ignored
    assert not any(line.startswith(("app", "/app")) for line in ignored)
    for rel in LIBRARY_FILES:
        assert (BACKEND / rel).is_file(), rel
    for rel in RETIRED_FILES:
        assert not has_source(BACKEND / rel), f"{rel} is retired (SPEC §4.10.16)"
    # Judged by its sources: a checkout that ran the backend before the removal keeps
    # the ignored ``playbooks/__pycache__/``, which ships and imports nothing.
    assert not has_source(BACKEND / "playbooks")
    assert (BACKEND / "app/threat/mitre_techniques.json").is_file()
    assert (BACKEND / "app/llm/model_registry.json").is_file()


def test_pyproject_discovers_subpackages_dependencies_and_data() -> None:
    data = tomllib.loads((BACKEND / "pyproject.toml").read_text(encoding="utf-8"))
    setuptools = data["tool"]["setuptools"]
    assert setuptools["packages"]["find"]["include"] == ["app*"]
    assert setuptools["dynamic"]["dependencies"]["file"] == ["requirements.txt"]
    assert setuptools["dynamic"]["optional-dependencies"]["connectors"]["file"] == [
        "requirements-connectors.txt"
    ]
    assert "runbooks/library/*.md" in setuptools["package-data"]["app"]
    assert "runbooks/*.md" not in setuptools["package-data"]["app"]
    assert "playbooks" not in setuptools["package-data"]


def test_sdist_manifest_carries_the_library_and_not_the_retired_directory() -> None:
    manifest = (BACKEND / "MANIFEST.in").read_text(encoding="utf-8").splitlines()
    assert "recursive-include app *.json *.md" in manifest
    assert not any("playbooks" in line for line in manifest)


def test_ci_verifies_the_library_in_the_wheel_and_the_image() -> None:
    """The CI image lane is the only place the real image is built; it must prove the
    12 built-in runbooks load inside it, and the wheel check must count them."""
    workflow = (REPO / ".github/workflows/ci.yml").read_text(encoding="utf-8")
    assert 'name.startswith("app/runbooks/library/")' in workflow
    assert "assert len(library) == 12" in workflow
    assert 'name.startswith("playbooks/") and name.endswith(".md") for name in names' not in workflow
    assert (
        "from app.engine.runbook_model import BUILTIN_RUNBOOK_IDS, load_builtin_runbooks; "
        "assert sorted(r.id for r in load_builtin_runbooks()) == sorted(BUILTIN_RUNBOOK_IDS) "
        "and len(BUILTIN_RUNBOOK_IDS) == 12"
    ) in workflow


def _pristine_source_tree(dest: Path) -> Path:
    """A copy of exactly what the build reads, so a stale ``build/`` directory left by
    an earlier local build (which ``bdist_wheel`` would package) cannot hide a file the
    sources no longer ship."""
    root = dest / "src"
    root.mkdir()
    for name in ("pyproject.toml", "MANIFEST.in", "README.md", "requirements.txt",
                 "requirements-connectors.txt"):
        shutil.copy2(BACKEND / name, root / name)
    shutil.copytree(
        BACKEND / "app", root / "app",
        ignore=shutil.ignore_patterns("__pycache__", "*.pyc"),
    )
    return root


def test_built_wheel_contains_all_python_modules_and_runtime_data(tmp_path: Path) -> None:
    """Build without isolation/network and inspect the actual wheel, not config intent."""
    out = tmp_path / "dist"
    source = _pristine_source_tree(tmp_path)
    env = {**os.environ, "PIP_NO_INDEX": "1"}
    subprocess.run(
        [sys.executable, "-m", "build", "--sdist", "--wheel", "--no-isolation", "--outdir", str(out)],
        cwd=source,
        env=env,
        check=True,
        capture_output=True,
        text=True,
    )
    wheels = list(out.glob("*.whl"))
    assert len(wheels) == 1
    sdists = list(out.glob("*.tar.gz"))
    assert len(sdists) == 1
    with tarfile.open(sdists[0]) as sdist:
        members = {"/".join(m.name.split("/")[1:]) for m in sdist.getmembers()}
    assert LIBRARY_FILES <= members, sorted(LIBRARY_FILES - members)
    assert not _retired_names(members), _retired_names(members)

    with zipfile.ZipFile(wheels[0]) as archive:
        names = set(archive.namelist())
        expected_modules = {
            path.relative_to(BACKEND).as_posix()
            for path in (BACKEND / "app").rglob("*.py")
            if "__pycache__" not in path.parts
        }
        assert expected_modules <= names
        assert "app/llm/model_registry.json" in names
        assert "app/threat/mitre_techniques.json" in names
        # The 12 built-in runbooks ship; no retired procedure file or module does.
        assert LIBRARY_FILES <= names, sorted(LIBRARY_FILES - names)
        library = {n for n in names if n.startswith("app/runbooks/library/") and n.endswith(".md")}
        assert len(library) == 12
        assert not _retired_names(names), _retired_names(names)
        assert not any(n.startswith("app/playbooks/") for n in names)
        for gone in ("app/engine/runbooks.py", "app/engine/runbook_service.py",
                     "app/stores/playbooks.py", "app/stores/runbooks.py"):
            assert gone not in names, gone
        metadata_name = next(name for name in names if name.endswith(".dist-info/METADATA"))
        metadata = archive.read(metadata_name).decode("utf-8")
        assert "Provides-Extra: connectors" in metadata
        for dependency in _requirement_names(BACKEND / "requirements-connectors.txt"):
            assert f"requires-dist: {dependency}" in metadata.lower()

        extracted = tmp_path / "wheel"
        archive.extractall(extracted)

    smoke = (
        "import importlib.util; "
        "import app; "
        "from app.engine.runbook_model import BUILTIN_RUNBOOK_IDS, RUNBOOK_LIBRARY_DIR, "
        "load_builtin_runbooks; "
        "assert str(RUNBOOK_LIBRARY_DIR).startswith(str(__import__('pathlib').Path(app.__file__)"
        ".resolve().parent)); "
        "loaded = load_builtin_runbooks(); "
        "assert sorted(r.id for r in loaded) == sorted(BUILTIN_RUNBOOK_IDS); "
        "assert len(loaded) == 12; "
        "assert importlib.util.find_spec('playbooks') is None"
    )
    subprocess.run(
        [sys.executable, "-c", smoke],
        cwd=tmp_path,
        env={**os.environ, "PYTHONPATH": str(extracted)},
        check=True,
        capture_output=True,
        text=True,
    )
