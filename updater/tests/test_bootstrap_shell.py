"""Executable shell regressions for exact-version supervisor bootstrap replacement.

The production bootstrap is copied into a temporary synthetic release checkout and
run with fake ``git``, ``docker``, and Compose executables.  This exercises the real
shell control flow without touching the developer's Docker daemon or checkout.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import textwrap
import unittest
from dataclasses import dataclass
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
BOOTSTRAP = ROOT / "scripts" / "bootstrap-updater.sh"
RELEASE_SHA = "1" * 40
CANONICAL_REPOSITORY_LINE = "AGENTIC_SOC_UPDATE_REPOSITORY=ARYDESTROYER/Kavach-AgenticSOC"
_DEFAULT_REPOSITORY_LINE = object()
PRIOR_UPDATER_IMAGE = f"sha256:{'8' * 64}"
EXISTING_ACTIVE_OVERRIDE = (
    "services:\n"
    "  agentic-soc-updater:\n"
    f"    image: ghcr.io/arydestroyer/kavach-agenticsoc/updater@{PRIOR_UPDATER_IMAGE}\n"
    "  tlsoc-backend:\n"
    "    image: ghcr.io/arydestroyer/kavach-agenticsoc/backend@"
    f"sha256:{'7' * 64}\n"
)


@dataclass(frozen=True)
class BootstrapRun:
    process: subprocess.CompletedProcess[str]
    calls: tuple[str, ...]
    active_override: str | None
    preserved_override_exists: bool
    final_phase: str


def _write_executable(path: Path, source: str) -> None:
    path.write_text(textwrap.dedent(source).lstrip(), encoding="utf-8")
    path.chmod(0o700)


def _run_bootstrap(
    *,
    replacement_status_version: str,
    existing_active_override: str | None = None,
    repository_line: object = _DEFAULT_REPOSITORY_LINE,
) -> BootstrapRun:
    """Run the shipping bootstrap; ``repository_line=None`` leaves the line out."""
    if repository_line is _DEFAULT_REPOSITORY_LINE:
        repository_line = CANONICAL_REPOSITORY_LINE
    with tempfile.TemporaryDirectory(prefix="agentic-soc-bootstrap-shell-") as directory:
        checkout = Path(directory)
        scripts = checkout / "scripts"
        fake_bin = checkout / "fake-bin"
        scripts.mkdir()
        fake_bin.mkdir()

        shutil.copy2(BOOTSTRAP, scripts / BOOTSTRAP.name)
        shutil.copytree(
            ROOT / "updater",
            checkout / "updater",
            ignore=shutil.ignore_patterns("__pycache__", "*.pyc"),
        )
        (checkout / "VERSION").write_text("0.1.10\n", encoding="utf-8")
        env_lines = [
            "TLSOC_AUTH_ENABLED=true",
            "TLSOC_AUTH_JWT_SECRET=0123456789abcdef0123456789abcdef",
            "TLSOC_PG_PASSWORD=durable-test-password",
        ]
        if repository_line is not None:
            env_lines.append(str(repository_line))
        (checkout / ".env").write_text("\n".join((*env_lines, "")), encoding="utf-8")

        phase_file = checkout / "phase"
        call_log = checkout / "calls.log"
        phase_file.write_text("old\n", encoding="utf-8")
        if existing_active_override is not None:
            runtime = checkout / ".agentic-soc-runtime"
            runtime.mkdir(mode=0o700)
            (runtime / "active-release.compose.yml").write_text(
                existing_active_override,
                encoding="utf-8",
            )

        _write_executable(
            fake_bin / "git",
            """
            #!/usr/bin/env bash
            set -Eeuo pipefail
            case "${1:-} ${2:-}" in
              "status --porcelain")
                exit 0
                ;;
              "fetch --force")
                exit 0
                ;;
              "cat-file -t")
                printf 'tag\n'
                exit 0
                ;;
              "rev-parse refs/tags"*|"rev-parse HEAD")
                printf '%s\n' "${BOOTSTRAP_FAKE_RELEASE_SHA}"
                exit 0
                ;;
              "merge-base --is-ancestor")
                exit 0
                ;;
            esac
            printf 'unexpected fake git invocation: %s\n' "$*" >&2
            exit 91
            """,
        )
        _write_executable(
            fake_bin / "docker",
            """
            #!/usr/bin/env bash
            set -Eeuo pipefail

            phase="$(tr -d '\r\n' < "${BOOTSTRAP_FAKE_PHASE_FILE}")"
            if [[ "${1:-}" == compose && "${2:-}" == version ]]; then
              printf 'docker|compose-version|%s\n' "${phase}" >> "${BOOTSTRAP_FAKE_CALL_LOG}"
              exit 0
            fi

            if [[ "${1:-}" == inspect ]]; then
              if [[ "${2:-}" == --format ]]; then
                template="${3:-}"
                case "${template}" in
                  *'.Image'*)
                    printf 'docker|image|%s\n' "${phase}" >> "${BOOTSTRAP_FAKE_CALL_LOG}"
                    printf '%s\n' "${BOOTSTRAP_FAKE_PRIOR_IMAGE}"
                    exit 0
                    ;;
                  *'.State.Health'*)
                    printf 'docker|health|%s\n' "${phase}" >> "${BOOTSTRAP_FAKE_CALL_LOG}"
                    if [[ "${phase}" == old ]]; then
                      printf 'unhealthy\n'
                    else
                      printf 'healthy\n'
                    fi
                    exit 0
                    ;;
                esac
              fi
              printf 'docker|inspect|%s|%s\n' "${phase}" "${2:-}" >> "${BOOTSTRAP_FAKE_CALL_LOG}"
              exit 0
            fi

            if [[ "${1:-}" == exec ]]; then
              case "$*" in
                *'GET /v1/status HTTP/1.1'*)
                  version=0.1.8
                  if [[ "${phase}" == new ]]; then
                    version="${BOOTSTRAP_FAKE_REPLACEMENT_STATUS_VERSION}"
                  fi
                  printf 'docker|status|%s|%s\n' "${phase}" "${version}" >> "${BOOTSTRAP_FAKE_CALL_LOG}"
                  printf '{"available":true,"protocol_version":1,"updater_version":"%s","state":"ready","active_job":null,"capabilities":{"preflight":true,"start":true,"cancel":true,"rollback":true}}\n' "${version}"
                  exit 0
                  ;;
                *'/v1/preflight'*)
                  printf 'docker|preflight|%s\n' "${phase}" >> "${BOOTSTRAP_FAKE_CALL_LOG}"
                  printf '%s\n' '{"blockers":[{"message":"intentional test stop","remediation":"none"}]}'
                  exit 0
                  ;;
              esac
            fi

            printf 'unexpected fake docker invocation: %s\n' "$*" >&2
            exit 92
            """,
        )
        _write_executable(
            scripts / "agentic-soc-compose.sh",
            """
            #!/usr/bin/env bash
            set -Eeuo pipefail
            phase="$(tr -d '\r\n' < "${BOOTSTRAP_FAKE_PHASE_FILE}")"
            printf 'compose|%s|version=%s|channel=%s|sha=%s|args=%s\n' \
              "${phase}" "${TLSOC_VERSION:-}" "${TLSOC_RELEASE_CHANNEL:-}" \
              "${TLSOC_BUILD_SHA:-}" "$*" >> "${BOOTSTRAP_FAKE_CALL_LOG}"
            case "$*" in
              "up --detach --build --force-recreate agentic-soc-updater")
                printf 'new\n' > "${BOOTSTRAP_FAKE_PHASE_FILE}"
                ;;
              "up --detach --no-build --force-recreate agentic-soc-updater")
                printf 'old-restored\n' > "${BOOTSTRAP_FAKE_PHASE_FILE}"
                ;;
              *)
                printf 'unexpected fake Compose invocation: %s\n' "$*" >&2
                exit 93
                ;;
            esac
            """,
        )

        environment = dict(os.environ)
        environment.update(
            {
                "PATH": f"{fake_bin}{os.pathsep}{environment['PATH']}",
                "PYTHONDONTWRITEBYTECODE": "1",
                "BOOTSTRAP_FAKE_CALL_LOG": str(call_log),
                "BOOTSTRAP_FAKE_PHASE_FILE": str(phase_file),
                "BOOTSTRAP_FAKE_PRIOR_IMAGE": PRIOR_UPDATER_IMAGE,
                "BOOTSTRAP_FAKE_RELEASE_SHA": RELEASE_SHA,
                "BOOTSTRAP_FAKE_REPLACEMENT_STATUS_VERSION": replacement_status_version,
            }
        )
        process = subprocess.run(
            ["/bin/bash", str(scripts / BOOTSTRAP.name)],
            cwd=checkout,
            env=environment,
            capture_output=True,
            text=True,
            check=False,
            timeout=15,
        )

        runtime = checkout / ".agentic-soc-runtime"
        active_override_path = runtime / "active-release.compose.yml"
        preserved_override_path = (
            runtime / "active-release.compose.yml.bootstrap-preserved"
        )
        return BootstrapRun(
            process=process,
            calls=tuple(call_log.read_text(encoding="utf-8").splitlines()),
            active_override=(
                active_override_path.read_text(encoding="utf-8")
                if active_override_path.exists()
                else None
            ),
            preserved_override_exists=preserved_override_path.exists(),
            final_phase=phase_file.read_text(encoding="utf-8").strip(),
        )


class BootstrapShellRegressionTests(unittest.TestCase):
    _WORKLOAD_SERVICES = (
        "tlsoc-backend",
        "tlsoc-webui",
        "tlsoc-postgres",
        "tlsoc-redis",
    )

    def _compose_calls(self, result: BootstrapRun) -> list[str]:
        calls = [line for line in result.calls if line.startswith("compose|")]
        self.assertGreaterEqual(len(calls), 1, result.process.stderr)
        for call in calls:
            self.assertIn("agentic-soc-updater", call)
            for service in self._WORKLOAD_SERVICES:
                self.assertNotIn(service, call)
        return calls

    def test_version_mismatched_idle_v018_is_recreated_only_as_v0110_updater(
        self,
    ) -> None:
        result = _run_bootstrap(replacement_status_version="0.1.10")

        self.assertNotEqual(result.process.returncode, 0)
        compose_calls = self._compose_calls(result)
        self.assertIn(
            "compose|old|version=0.1.10|channel=stable|"
            f"sha={RELEASE_SHA}|args=up --detach --build --force-recreate "
            "agentic-soc-updater",
            compose_calls,
        )
        self.assertNotIn("docker|health|old", result.calls)
        self.assertIn("docker|health|new", result.calls)
        self.assertIn("docker|status|new|0.1.10", result.calls)
        self.assertIn("docker|preflight|new", result.calls)

    def test_post_replacement_verification_failure_restores_prior_updater(self) -> None:
        result = _run_bootstrap(replacement_status_version="0.1.8")

        self.assertNotEqual(result.process.returncode, 0)
        self.assertIn(
            "the installed updater is not ready for signed release preflight",
            result.process.stderr,
        )
        compose_calls = self._compose_calls(result)
        self.assertEqual(len(compose_calls), 2, compose_calls)
        self.assertIn(
            "args=up --detach --build --force-recreate agentic-soc-updater",
            compose_calls[0],
        )
        self.assertIn(
            "args=up --detach --no-build --force-recreate agentic-soc-updater",
            compose_calls[1],
        )
        self.assertNotIn("docker|preflight|new", result.calls)
        self.assertEqual(result.final_phase, "old-restored")
        self.assertFalse(result.preserved_override_exists)
        self.assertEqual(
            result.active_override,
            "# Bootstrap recovery override. Remove only after the replacement succeeds.\n"
            "services:\n"
            "  agentic-soc-updater:\n"
            f"    image: {PRIOR_UPDATER_IMAGE}\n",
        )

    def _assert_refused_before_any_change(self, result: BootstrapRun, message: str) -> None:
        self.assertNotEqual(result.process.returncode, 0)
        self.assertIn("Updater bootstrap refused:", result.process.stderr)
        self.assertIn(message, result.process.stderr)
        self.assertIn(CANONICAL_REPOSITORY_LINE, result.process.stderr)
        # Refused before Docker, the supervisor or Compose is touched.
        self.assertEqual(
            [call for call in result.calls if not call.startswith("docker|compose-version|")],
            [],
        )
        self.assertIsNone(result.active_override)
        self.assertEqual(result.final_phase, "old")

    def test_a_missing_update_repository_is_refused(self) -> None:
        result = _run_bootstrap(replacement_status_version="0.1.10", repository_line=None)
        self._assert_refused_before_any_change(
            result, "AGENTIC_SOC_UPDATE_REPOSITORY is not set"
        )

    def test_the_former_repository_is_refused_in_any_case(self) -> None:
        for value in ("ARYDESTROYER/Agentic-Kibana", "arydestroyer/agentic-kibana"):
            with self.subTest(value=value):
                result = _run_bootstrap(
                    replacement_status_version="0.1.10",
                    repository_line=f"AGENTIC_SOC_UPDATE_REPOSITORY={value}",
                )
                self._assert_refused_before_any_change(result, "names the former repository")

    def test_the_new_repository_in_the_wrong_case_is_refused(self) -> None:
        result = _run_bootstrap(
            replacement_status_version="0.1.10",
            repository_line="AGENTIC_SOC_UPDATE_REPOSITORY=ARYDESTROYER/kavach-agenticsoc",
        )
        self._assert_refused_before_any_change(result, "the signing identity is case-sensitive")

    def test_a_fork_passes_the_identity_check(self) -> None:
        result = _run_bootstrap(
            replacement_status_version="0.1.10",
            repository_line="AGENTIC_SOC_UPDATE_REPOSITORY=example-org/Kavach-AgenticSOC",
        )
        self.assertNotIn("AGENTIC_SOC_UPDATE_REPOSITORY", result.process.stderr)
        self.assertIn("docker|preflight|new", result.calls)

    def test_failed_replacement_restores_existing_active_override_exactly(self) -> None:
        result = _run_bootstrap(
            replacement_status_version="0.1.8",
            existing_active_override=EXISTING_ACTIVE_OVERRIDE,
        )

        self.assertNotEqual(result.process.returncode, 0)
        self.assertIn(
            "the installed updater is not ready for signed release preflight",
            result.process.stderr,
        )
        compose_calls = self._compose_calls(result)
        self.assertEqual(len(compose_calls), 2, compose_calls)
        self.assertIn(
            "args=up --detach --build --force-recreate agentic-soc-updater",
            compose_calls[0],
        )
        self.assertIn(
            "args=up --detach --no-build --force-recreate agentic-soc-updater",
            compose_calls[1],
        )
        self.assertEqual(result.final_phase, "old-restored")
        self.assertFalse(result.preserved_override_exists)
        self.assertEqual(result.active_override, EXISTING_ACTIVE_OVERRIDE)


if __name__ == "__main__":
    unittest.main()
