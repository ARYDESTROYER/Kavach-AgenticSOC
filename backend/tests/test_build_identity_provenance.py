"""Build and deploy provenance: one derivation, two honest questions about it.

Three separate defects converge on the same value:

* ``scripts/agentic-soc-compose.sh`` never derived ``TLSOC_BUILD_SHA`` /
  ``TLSOC_BUILD_DATE``, so the Compose build arguments fell through to the literal
  ``unknown`` and every canonical source build stamped ``revision=unknown``.
* ``/api/health/build-info`` tested those values against the string ``"unknown"``
  while ``engine/update_service`` independently applied an exact-40-hex check, so an
  operator could read complete provenance and still be refused an update with no
  visible reason.
* ``.env.example`` shipped both variables as the literal ``unknown``, pre-committing
  every deployer who copied it.

These tests pin the fixes AND the three traps the derivation must not fall into.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from contextlib import asynccontextmanager
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import __version__
from app.api.routes import router
from app.build_identity import (
    BUILD_IDENTITY_NOT_EXACT_SOURCE_REVISION,
    BUILD_IDENTITY_PARTIALLY_STAMPED,
    build_identity_advisories,
    build_stamp,
    is_exact_source_revision,
    log_build_identity_advisories,
)
from app.es.fake import InMemoryESClient
from app.state import AppState


ROOT = Path(__file__).resolve().parents[2]
LIBRARY = ROOT / "scripts" / "lib" / "build-identity.sh"

EXACT = "a" * 40


# --------------------------------------------------------------------------- #
# H1 — the shared shell derivation and its three traps.
# --------------------------------------------------------------------------- #
def _git(repo: Path, *args: str) -> None:
    subprocess.run(
        ["git", "-C", str(repo), *args],
        check=True,
        capture_output=True,
        text=True,
    )


@pytest.fixture
def source_checkout(tmp_path: Path) -> Path:
    repo = tmp_path / "checkout"
    repo.mkdir()
    _git(repo, "init", "-q")
    _git(repo, "config", "user.email", "provenance@example.invalid")
    _git(repo, "config", "user.name", "provenance")
    (repo / "tracked.txt").write_text("one\n", encoding="utf-8")
    _git(repo, "add", "tracked.txt")
    _git(repo, "commit", "-qm", "initial")
    return repo


def _derive(repo: Path, env_file: Path | None = None, **environment: str) -> dict[str, str]:
    """Run the shipped derivation in a clean shell and report what it resolved."""
    script = f"""
set -Eeuo pipefail
. "{LIBRARY}"
tlsoc_derive_build_identity "{repo}" "{env_file or ''}"
tlsoc_report_build_identity "TEST"
printf 'exported_sha=%s\\n' "${{TLSOC_BUILD_SHA:-<unset>}}"
printf 'exported_date=%s\\n' "${{TLSOC_BUILD_DATE:-<unset>}}"
printf 'effective_sha=%s\\n' "${{TLSOC_BUILD_IDENTITY_SHA:-<unset>}}"
printf 'origin_sha=%s\\n' "${{TLSOC_BUILD_IDENTITY_ORIGIN_SHA}}"
printf 'origin_date=%s\\n' "${{TLSOC_BUILD_IDENTITY_ORIGIN_DATE}}"
"""
    clean = {
        key: value
        for key, value in os.environ.items()
        if key not in {"TLSOC_BUILD_SHA", "TLSOC_BUILD_DATE"}
    }
    clean.update(environment)
    completed = subprocess.run(
        ["bash", "-c", script], capture_output=True, text=True, env=clean, check=True
    )
    resolved = dict(
        line.split("=", 1)
        for line in completed.stdout.strip().splitlines()
        if "=" in line
    )
    resolved["_stderr"] = completed.stderr
    return resolved


def test_shipped_wrappers_share_one_derivation() -> None:
    """H1's root cause: the Compose wrapper had no derivation at all."""
    assert LIBRARY.is_file()
    for relative in ("scripts/agentic-soc-compose.sh", "scripts/run-demo.sh"):
        source = (ROOT / relative).read_text(encoding="utf-8")
        assert "lib/build-identity.sh" in source, relative
        assert "tlsoc_derive_build_identity" in source, relative
        assert "tlsoc_report_build_identity" in source, relative
    # run-demo.sh must no longer carry its own private copy of the derivation.
    demo = (ROOT / "scripts/run-demo.sh").read_text(encoding="utf-8")
    assert 'TLSOC_BUILD_SHA="${TLSOC_BUILD_SHA:-$(git' not in demo


def test_derivation_stamps_the_exact_head_revision(source_checkout: Path) -> None:
    head = subprocess.run(
        ["git", "-C", str(source_checkout), "rev-parse", "HEAD"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    resolved = _derive(source_checkout)
    assert resolved["exported_sha"] == head
    assert is_exact_source_revision(resolved["exported_sha"])
    assert resolved["exported_date"] not in ("", "unknown", "<unset>")
    assert resolved["_stderr"] == ""


def test_trap_one_a_supplied_release_identity_is_never_modified(
    source_checkout: Path,
) -> None:
    """The supervised bootstrap exports the verified release identity.

    A dirty suffix appended to a verified release SHA would fail the updater's
    exact-object-id check and permanently disable one-click updates on a correctly
    bootstrapped host, so the derivation must not touch a supplied value even when
    the checkout it happens to run in is filthy.
    """
    (source_checkout / "tracked.txt").write_text("locally edited\n", encoding="utf-8")
    (source_checkout / "untracked.txt").write_text("note\n", encoding="utf-8")

    resolved = _derive(
        source_checkout,
        TLSOC_BUILD_SHA=EXACT,
        TLSOC_BUILD_DATE="2026-01-01T00:00:00Z",
    )
    assert resolved["exported_sha"] == EXACT
    assert resolved["exported_date"] == "2026-01-01T00:00:00Z"
    assert resolved["origin_sha"] == "supplied"
    assert resolved["origin_date"] == "supplied"
    assert "-dirty" not in resolved["exported_sha"]
    assert resolved["_stderr"] == ""


def test_trap_two_untracked_files_are_not_dirt_but_tracked_edits_are(
    source_checkout: Path,
) -> None:
    """``git status --porcelain`` counts untracked files; the probe must not.

    Otherwise a single operator note dropped into the deployment directory marks
    every subsequent build dirty forever.
    """

    def counts() -> tuple[int, int]:
        porcelain = subprocess.run(
            ["git", "-C", str(source_checkout), "status", "--porcelain"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.splitlines()
        tracked = subprocess.run(
            ["git", "-C", str(source_checkout), "diff", "--name-only", "HEAD", "--"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.splitlines()
        return len(porcelain), len(tracked)

    (source_checkout / "operator-note.txt").write_text("keep me\n", encoding="utf-8")
    porcelain_count, tracked_count = counts()
    assert (porcelain_count, tracked_count) == (1, 0)
    untracked_only = _derive(source_checkout)
    assert not untracked_only["exported_sha"].endswith("-dirty")
    assert is_exact_source_revision(untracked_only["exported_sha"])
    assert untracked_only["_stderr"] == ""

    (source_checkout / "tracked.txt").write_text("two\n", encoding="utf-8")
    porcelain_count, tracked_count = counts()
    assert (porcelain_count, tracked_count) == (2, 1)
    modified = _derive(source_checkout)
    assert modified["exported_sha"].endswith("-dirty")
    assert not is_exact_source_revision(modified["exported_sha"])
    # Never silent: a non-reproducible identity is named on stderr.
    assert "TLSOC_BUILD_SHA=" in modified["_stderr"]
    assert modified["exported_sha"] in modified["_stderr"]


def test_trap_three_an_env_file_pin_outranks_derivation(
    source_checkout: Path, tmp_path: Path
) -> None:
    """The --env-file is read by Compose, but an exported shell value outranks it.

    So a derived HEAD would silently override a documented operator pin. The probe
    must suppress the derivation WITHOUT exporting anything.
    """
    pinned = tmp_path / "env.pinned"
    pinned.write_text(
        'export TLSOC_BUILD_SHA="{sha}"\nTLSOC_BUILD_DATE=2020-02-02T00:00:00Z\n'.format(
            sha="b" * 40
        ),
        encoding="utf-8",
    )
    resolved = _derive(source_checkout, pinned)
    assert resolved["exported_sha"] == "<unset>"
    assert resolved["exported_date"] == "<unset>"
    assert resolved["origin_sha"] == "pinned"
    assert resolved["origin_date"] == "pinned"
    assert resolved["effective_sha"] == "b" * 40
    assert resolved["_stderr"] == ""


def test_a_literal_unknown_in_the_env_file_is_not_a_pin(
    source_checkout: Path, tmp_path: Path
) -> None:
    """The exact shape ``.env.example`` used to ship must still be filled in."""
    legacy = tmp_path / "env.unknown"
    legacy.write_text("TLSOC_BUILD_SHA=unknown\nTLSOC_BUILD_DATE=unknown\n", encoding="utf-8")
    resolved = _derive(source_checkout, legacy)
    assert resolved["origin_sha"] == "derived"
    assert is_exact_source_revision(resolved["exported_sha"])


def test_a_non_git_source_tree_reports_unknown_loudly(tmp_path: Path) -> None:
    plain = tmp_path / "tarball"
    plain.mkdir()
    resolved = _derive(plain)
    assert resolved["exported_sha"] == "unknown"
    assert resolved["exported_date"] == "unknown"
    assert "TLSOC_BUILD_SHA=unknown" in resolved["_stderr"]


def test_env_example_no_longer_pre_commits_deployers_to_unknown() -> None:
    source = (ROOT / ".env.example").read_text(encoding="utf-8")
    executable = [
        line for line in source.splitlines() if not line.lstrip().startswith("#")
    ]
    assert not any(line.startswith("TLSOC_BUILD_SHA=") for line in executable)
    assert not any(line.startswith("TLSOC_BUILD_DATE=") for line in executable)
    assert "# TLSOC_BUILD_SHA=" in source
    assert "# TLSOC_BUILD_DATE=" in source


# --------------------------------------------------------------------------- #
# H2 — two questions about the same value, reported additively.
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (EXACT, True),
        (EXACT.upper(), True),
        (f"  {EXACT}  ", True),
        (f"{EXACT}-dirty", False),
        ("a" * 39, False),
        ("a" * 41, False),
        ("a" * 64, False),  # sha256 object ids stay out of scope, deliberately
        ("abc1234", False),
        ("v0.1.13", False),
        ("unknown", False),
        ("", False),
        (None, False),
    ],
)
def test_exact_source_revision_predicate(value: object, expected: bool) -> None:
    assert is_exact_source_revision(value) is expected


def test_advisories_never_narrow_the_completeness_question() -> None:
    # Complete AND pinnable: nothing to say.
    assert build_identity_advisories(EXACT, "2026-01-01T00:00:00Z") == []
    # Complete but not pinnable — a tarball/Nix/CI build id stays honest provenance.
    assert build_identity_advisories("build-4711", "2026-01-01T00:00:00Z") == [
        BUILD_IDENTITY_NOT_EXACT_SOURCE_REVISION
    ]
    # Neither stamped: incomplete, but not incoherent.
    assert build_identity_advisories("unknown", "unknown") == []
    # Half-stamped in either direction.
    assert build_identity_advisories(EXACT, "unknown") == [BUILD_IDENTITY_PARTIALLY_STAMPED]
    assert build_identity_advisories("unknown", "2026-01-01T00:00:00Z") == [
        BUILD_IDENTITY_PARTIALLY_STAMPED
    ]


def test_startup_warns_but_never_blocks(monkeypatch, caplog) -> None:
    monkeypatch.setenv("TLSOC_BUILD_SHA", f"{EXACT}-dirty")
    monkeypatch.setenv("TLSOC_BUILD_DATE", "2026-01-01T00:00:00Z")
    with caplog.at_level("WARNING", logger="tlsoc.build_identity"):
        assert log_build_identity_advisories() == [
            BUILD_IDENTITY_NOT_EXACT_SOURCE_REVISION
        ]
    assert any("not an exact source revision" in record.message for record in caplog.records)

    caplog.clear()
    monkeypatch.setenv("TLSOC_BUILD_DATE", "unknown")
    with caplog.at_level("WARNING", logger="tlsoc.build_identity"):
        assert log_build_identity_advisories() == [
            BUILD_IDENTITY_NOT_EXACT_SOURCE_REVISION,
            BUILD_IDENTITY_PARTIALLY_STAMPED,
        ]
    assert any("half-stamped" in record.message for record in caplog.records)

    caplog.clear()
    monkeypatch.setenv("TLSOC_BUILD_SHA", EXACT)
    monkeypatch.setenv("TLSOC_BUILD_DATE", "2026-01-01T00:00:00Z")
    with caplog.at_level("WARNING", logger="tlsoc.build_identity"):
        assert log_build_identity_advisories() == []
    assert caplog.records == []


def test_application_startup_emits_the_detector() -> None:
    source = (ROOT / "backend/app/main.py").read_text(encoding="utf-8")
    assert "log_build_identity_advisories(logger)" in source


def test_deploy_guidance_separates_the_two_provenance_channels(monkeypatch, caplog) -> None:
    """A fully unstamped build is reported by completeness, not by an advisory.

    ``build_identity_advisories`` is deliberately scoped to a build that *looks*
    stamped but cannot be pinned; an unstamped pair is incomplete, not incoherent, so
    it returns ``[]`` and logs nothing. Deployment guidance that promised a startup
    warning for that case sent an operator hunting a line that is never written —
    while the state itself is fully reported, by ``provenance_complete`` /
    ``provenance_missing``.
    """
    assert build_identity_advisories("unknown", "unknown") == []
    monkeypatch.delenv("TLSOC_BUILD_SHA", raising=False)
    monkeypatch.delenv("TLSOC_BUILD_DATE", raising=False)
    with caplog.at_level("WARNING", logger="tlsoc.build_identity"):
        assert log_build_identity_advisories() == []
    assert caplog.records == []

    deploy = (ROOT / "DEPLOY.md").read_text(encoding="utf-8")
    assert "provenance_complete: false" in deploy
    assert "provenance_missing" in deploy
    assert "provenance_advisories" in deploy
    assert "logs a startup warning for both cases" not in deploy


def test_update_service_uses_the_shared_predicate() -> None:
    """The two definitions of 'immutable revision' must not drift apart again."""
    source = (ROOT / "backend/app/engine/update_service.py").read_text(encoding="utf-8")
    assert "from ..build_identity import is_exact_source_revision" in source
    assert 're.fullmatch(r"[0-9a-f]{40}"' not in source

    from app.engine import update_service

    monkeyed = {"TLSOC_BUILD_SHA": EXACT}
    previous = os.environ.get("TLSOC_BUILD_SHA")
    try:
        os.environ.update(monkeyed)
        assert is_exact_source_revision(update_service._build_sha()) is True
        os.environ["TLSOC_BUILD_SHA"] = f"{EXACT}-dirty"
        assert is_exact_source_revision(update_service._build_sha()) is False
    finally:
        if previous is None:
            os.environ.pop("TLSOC_BUILD_SHA", None)
        else:
            os.environ["TLSOC_BUILD_SHA"] = previous


@pytest.fixture
def client(secrets, mock_provider):
    overrides = {"anthropic": mock_provider, "openai": mock_provider, "mock": mock_provider}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        state = AppState.create(
            secrets=secrets, es=InMemoryESClient(), provider_overrides=overrides
        )
        await state.startup(start_poller=False)
        app.state.tlsoc = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    api.include_router(router)
    with TestClient(api) as c:
        yield c


def test_build_info_reports_the_advisory_additively(client, monkeypatch) -> None:
    """A stamped-but-unpinnable build keeps its ORIGINAL completeness semantics.

    Collapsing the two questions would mark every non-git builder incomplete — a
    portability regression aimed at exactly the deployers furthest from the
    GitHub-shaped happy path.
    """
    monkeypatch.setenv("TLSOC_BUILD_SHA", "nix-2f9a1c")
    monkeypatch.setenv("TLSOC_BUILD_DATE", "2026-07-11T00:00:00Z")
    body = client.get("/api/health/build-info").json()

    # Unchanged, byte for byte, from before the advisory existed.
    assert body["commit_sha"] == "nix-2f9a1c"
    assert body["build_time"] == "2026-07-11T00:00:00Z"
    assert body["provenance_complete"] is True
    assert body["provenance_missing"] == []
    assert body["version"] == __version__
    # …and the new field explains why supervised updates still refuse this build.
    assert body["provenance_advisories"] == [BUILD_IDENTITY_NOT_EXACT_SOURCE_REVISION]

    monkeypatch.setenv("TLSOC_BUILD_SHA", EXACT)
    exact = client.get("/api/health/build-info").json()
    assert exact["provenance_complete"] is True
    assert exact["provenance_missing"] == []
    assert exact["provenance_advisories"] == []

    monkeypatch.setenv("TLSOC_BUILD_DATE", "")
    half = client.get("/api/health/build-info").json()
    assert half["provenance_complete"] is False
    assert half["provenance_missing"] == ["build_time"]
    assert half["provenance_advisories"] == [BUILD_IDENTITY_PARTIALLY_STAMPED]

    monkeypatch.setenv("TLSOC_BUILD_SHA", "")
    neither = client.get("/api/health/build-info").json()
    assert neither["provenance_complete"] is False
    assert neither["provenance_missing"] == ["commit_sha", "build_time"]
    assert neither["provenance_advisories"] == []
    assert build_stamp("TLSOC_BUILD_SHA") == "unknown"


# --------------------------------------------------------------------------- #
# H3 — the gate. An abbreviated revision must never reach a shipped recipe.
# --------------------------------------------------------------------------- #
def _mirror_repository(tmp_path: Path) -> Path:
    """A throwaway ROOT whose ``scripts/`` is real and everything else is a link.

    ``check_version.py`` resolves its ROOT from ``__file__``, so the copy has to be a
    real file. Symlinking the rest keeps the mirror cheap and read-only.
    """
    mirror = tmp_path / "mirror"
    mirror.mkdir()
    for entry in ROOT.iterdir():
        if entry.name == "scripts":
            shutil.copytree(entry, mirror / entry.name, symlinks=True)
        else:
            (mirror / entry.name).symlink_to(entry)
    return mirror


def _run_check_version(mirror: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(mirror / "scripts" / "check_version.py")],
        capture_output=True,
        text=True,
    )


def test_check_version_passes_on_the_unmodified_tree(tmp_path: Path) -> None:
    control = _run_check_version(_mirror_repository(tmp_path))
    assert control.returncode == 0, control.stderr


def test_check_version_rejects_a_short_rev_parse_derivation(tmp_path: Path) -> None:
    """Plant the violation, prove the gate fires, and remove it again.

    An abbreviated object id is not an exact revision, so a build stamped from one
    reports complete provenance that no upgrade can be pinned to.
    """
    mirror = _mirror_repository(tmp_path)
    planted = mirror / "scripts" / "run-demo.sh"
    original = planted.read_text(encoding="utf-8")
    planted.write_text(
        original
        + '\nTLSOC_BUILD_SHA="$(git rev-parse --short HEAD)"\n',
        encoding="utf-8",
    )

    violation = _run_check_version(mirror)
    assert violation.returncode == 1
    assert "abbreviated revision" in violation.stderr

    # A multi-line assignment must not slip past a same-line probe — in EITHER of
    # the two shapes shell offers. The second is the one that matters: a backslash
    # continuation is ordinary style, not an adversarial construction, and it really
    # does evaluate to the banned abbreviated id.
    for payload in (
        '\nTLSOC_BUILD_SHA="$(\n  git rev-parse --short HEAD\n)"\n',
        '\nTLSOC_BUILD_SHA="$(git rev-parse \\\n  --short HEAD)"\n',
        '\nTLSOC_BUILD_SHA="$(git rev-parse --verify \\\n  --short HEAD)"\n',
    ):
        planted.write_text(original + payload, encoding="utf-8")
        multiline = _run_check_version(mirror)
        assert multiline.returncode == 1, payload
        assert "abbreviated revision" in multiline.stderr, payload

    planted.write_text(original, encoding="utf-8")
    restored = _run_check_version(mirror)
    assert restored.returncode == 0, restored.stderr


def test_a_line_continuation_really_does_produce_the_banned_value(
    source_checkout: Path,
) -> None:
    """The payload above is working shell, not a strawman for the gate."""
    abbreviated = subprocess.run(
        ["bash", "-c", 'git -C "$1" rev-parse \\\n  --short HEAD', "_", str(source_checkout)],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    assert abbreviated
    assert not is_exact_source_revision(abbreviated)


@pytest.mark.parametrize(
    ("relative", "payload"),
    [
        # The literal spelling.
        ("scripts/lib/build-identity.sh", 'tlsoc_bi_dirt="$(git status --porcelain)"'),
        # The library's OWN house style — every git call in it is `git -C <root> …`,
        # so a substring search for `git status --porcelain` can never see this one.
        (
            "scripts/lib/build-identity.sh",
            (
                'if [ -n "$(git -C "${tlsoc_bi_root}" status --porcelain)" ]; then'
                ' tlsoc_bi_sha="${tlsoc_bi_sha}-dirty"; fi'
            ),
        ),
        # Split over a continuation, like the abbreviated-revision ban.
        (
            "scripts/lib/build-identity.sh",
            'tlsoc_bi_dirt="$(git -C "${tlsoc_bi_root}" status \\\n  --porcelain)"',
        ),
        # The wrappers derive nothing themselves today, but nothing stops a future
        # one re-adding a private dirty probe, so the ban covers them too.
        (
            "scripts/run-demo.sh",
            'test -z "$(git status --porcelain)" || TLSOC_BUILD_SHA="${TLSOC_BUILD_SHA}-dirty"',
        ),
        (
            "scripts/agentic-soc-compose.sh",
            'dirt="$(git -C "${repo_root}" status --porcelain)"',
        ),
    ],
)
def test_check_version_rejects_an_untracked_counting_dirty_probe(
    tmp_path: Path, relative: str, payload: str
) -> None:
    mirror = _mirror_repository(tmp_path)
    planted = mirror / relative
    original = planted.read_text(encoding="utf-8")
    planted.write_text(f"{original}\n{payload}\n", encoding="utf-8")

    violation = _run_check_version(mirror)
    assert violation.returncode == 1
    assert "only tracked modifications" in violation.stderr
    assert relative in violation.stderr

    planted.write_text(original, encoding="utf-8")
    assert _run_check_version(mirror).returncode == 0


def test_the_dirty_probe_ban_reads_code_not_prose(tmp_path: Path) -> None:
    """Two deliberate non-violations the ban must never flag.

    The library documents this exact trap in its header, and
    ``scripts/bootstrap-updater.sh`` demands a pristine checkout — counting untracked
    files is the correct behaviour there, so it stays outside the ban.
    """
    mirror = _mirror_repository(tmp_path)
    library = mirror / "scripts" / "lib" / "build-identity.sh"
    original = library.read_text(encoding="utf-8")
    library.write_text(
        original + '\n#   never: git -C "${root}" status --porcelain\n',
        encoding="utf-8",
    )
    commented = _run_check_version(mirror)
    assert commented.returncode == 0, commented.stderr

    # …but a comment ending in a backslash must not HIDE the code beneath it. A shell
    # comment ends at its newline regardless, so comments are dropped before
    # continuations are folded.
    library.write_text(
        original
        + '\n# a wrapped note ending in a backslash \\\n'
        + 'tlsoc_bi_dirt="$(git -C "${tlsoc_bi_root}" status --porcelain)"\n',
        encoding="utf-8",
    )
    hidden = _run_check_version(mirror)
    assert hidden.returncode == 1
    assert "only tracked modifications" in hidden.stderr
    library.write_text(original, encoding="utf-8")

    bootstrap = (ROOT / "scripts/bootstrap-updater.sh").read_text(encoding="utf-8")
    assert "git status --porcelain --untracked-files=all" in bootstrap
    restored = _run_check_version(mirror)
    assert restored.returncode == 0, restored.stderr
