from __future__ import annotations

import json
import asyncio
import io
import hashlib
import inspect
import os
from pathlib import Path
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "updater"))
sys.path.insert(0, str(ROOT / "backend"))

from agentic_soc_updater.contract import (  # noqa: E402
    ContractError,
    canonical_asset_urls,
    validate_plan,
    validate_release_request,
)
from agentic_soc_updater.bootstrap import (  # noqa: E402
    BootstrapStatusError,
    replacement_decision,
)
from agentic_soc_updater.service import (  # noqa: E402
    ServiceError,
    TERMINAL_STATUSES,
    UpdateService,
)
from agentic_soc_updater.store import JsonStore  # noqa: E402
from agentic_soc_updater.server import (  # noqa: E402
    MAX_TERMINAL_JOBS,
    Handler,
    UnixHTTPServer,
    _secure_control_socket,
    _terminal_limit,
    terminal_page,
)
from agentic_soc_updater.runtime import (  # noqa: E402
    CommandRunner,
    ComposeRuntime,
    RuntimeConfig,
    RuntimeFailure,
)


REPOSITORY = "ARYDESTROYER/Kavach-AgenticSOC"
CURRENT_SHA = "1" * 40
TARGET_SHA = "2" * 40


def plan_dict() -> dict:
    labels = {
        "org.opencontainers.image.version": "0.1.3",
        "org.opencontainers.image.revision": TARGET_SHA,
        "org.opencontainers.image.source": f"https://github.com/{REPOSITORY}",
        "dev.tlsoc.release.channel": "stable",
        "io.agentic-soc.state.schema": "1",
    }
    return {
        "schema_version": 1,
        "product": "agentic-soc",
        "release": {
            "version": "0.1.3",
            "tag": "v0.1.3",
            "channel": "stable",
            "commit_sha": TARGET_SHA,
            "published_at": "2026-08-03T00:00:00Z",
        },
        "compatibility": {
            "from": {"min_inclusive": "0.1.2", "max_exclusive": "0.2.0"},
            "state_backends": ["postgres"],
            "state_schema": 1,
            "compose_sha256": "9" * 64,
            "minimum_updater_protocol": 1,
            "backup_required": True,
            "migration": {"strategy": "none"},
        },
        "components": {
            name: {
                "image": f"ghcr.io/arydestroyer/kavach-agenticsoc/{name}@sha256:{digit * 64}",
                "digest": f"sha256:{digit * 64}",
                "labels": labels,
            }
            for name, digit in (("updater", "a"), ("backend", "b"), ("webui", "c"))
        },
        "rollout": {
            "backend_timeout_seconds": 60,
            "webui_timeout_seconds": 30,
            "observation_seconds": 5,
        },
    }


def release_dict() -> dict[str, str]:
    plan_url, bundle_url = canonical_asset_urls(REPOSITORY, "0.1.3")
    return {
        "release_id": "v0.1.3",
        "version": "0.1.3",
        "tag": "v0.1.3",
        "commit_sha": TARGET_SHA,
        "plan_url": plan_url,
        "bundle_url": bundle_url,
        "repository": REPOSITORY,
    }


class FakeRuntime:
    def __init__(
        self,
        *,
        fail_backend: bool = False,
        fail_quiesce: bool = False,
        fail_webui: bool = False,
        fail_override: bool = False,
        handoff: bool = False,
        backup_gate: threading.Event | None = None,
        pull_gate: threading.Event | None = None,
        preflight_gate: threading.Event | None = None,
        release_gate: threading.Event | None = None,
        fail_rollback: bool = False,
    ) -> None:
        self.fail_backend = fail_backend
        self.fail_quiesce = fail_quiesce
        self.fail_webui = fail_webui
        self.fail_override = fail_override
        self.handoff = handoff
        self.backup_gate = backup_gate
        self.pull_gate = pull_gate
        self.preflight_gate = preflight_gate
        self.release_gate = release_gate
        self.fail_rollback = fail_rollback
        self.backup_started = threading.Event()
        self.pull_started = threading.Event()
        self.preflight_started = threading.Event()
        self.release_started = threading.Event()
        self.rollback_calls = 0
        self.calls: list[str] = []
        self.fingerprint_generation = 0
        self.lifecycle_marker_job: str | None = None
        self.lifecycle_owner_job: str | None = None
        self.pending_override = False
        self.active_target_override = False
        self.current_identity = {
            "version": "0.1.2",
            "channel": "stable",
            "commit_sha": CURRENT_SHA,
            "state_schema": "1",
            "backend_image_id": f"sha256:{'d' * 64}",
            "webui_image_id": f"sha256:{'e' * 64}",
        }

    def verify_plan_signature(self, *_args) -> None:
        self.calls.append("verify_plan_signature")

    def verify_image_signatures(self, _plan) -> None:
        self.calls.append("verify_image_signatures")

    def preflight(self, _plan) -> dict:
        self.preflight_started.set()
        if self.preflight_gate is not None:
            self.preflight_gate.wait(timeout=4)
        return {
            "checks": [
                {"code": "deployment_shape", "label": "Deployment shape", "status": "pass", "detail": "Supported Compose/PostgreSQL profile"}
            ],
            "blockers": [],
            "warnings": [],
            "current": {"version": "0.1.2", "commit_sha": CURRENT_SHA},
        }

    def pull_and_validate(self, _plan) -> None:
        self.calls.append("pull")
        self.pull_started.set()
        if self.pull_gate is not None:
            self.pull_gate.wait(timeout=4)

    def installed_identity(self) -> dict[str, str]:
        return dict(self.current_identity)

    def deployment_fingerprint(self) -> dict[str, str]:
        self.calls.append("fingerprint")
        return {
            **self.current_identity,
            "updater_image_id": f"sha256:{'f' * 64}",
            "compose_sha256": f"compose-{self.fingerprint_generation}",
            "environment_sha256": "environment-0",
        }

    def capture_snapshot(self, job_id: str) -> dict:
        return {
            "job_id": job_id,
            "version": "0.1.2",
            "commit_sha": CURRENT_SHA,
            "backend_image_id": f"sha256:{'d' * 64}",
            "webui_image_id": f"sha256:{'e' * 64}",
            "channel": "stable",
            "state_schema": "1",
        }

    def begin_lifecycle(self, job_id: str) -> None:
        if self.lifecycle_owner_job == job_id:
            return
        if self.lifecycle_owner_job is not None:
            raise RuntimeError("another updater lifecycle guard is active")
        if self.lifecycle_marker_job not in {None, job_id}:
            raise RuntimeError("another update lifecycle is active")
        self.lifecycle_owner_job = job_id
        self.lifecycle_marker_job = job_id
        self.calls.append("lifecycle_begin")

    def release_lifecycle(self, job_id: str, *, terminal: bool) -> None:
        if self.lifecycle_owner_job is None:
            return
        if self.lifecycle_owner_job != job_id:
            raise RuntimeError("lifecycle guard owner changed")
        if terminal:
            self.release_started.set()
            if self.release_gate is not None:
                self.release_gate.wait(timeout=4)
            self.lifecycle_marker_job = None
        self.lifecycle_owner_job = None
        self.calls.append(f"lifecycle_release:{terminal}")

    def reconcile_terminal_lifecycle(self, terminal_job_ids: set[str]) -> bool:
        if (
            self.lifecycle_owner_job is None
            and self.lifecycle_marker_job in terminal_job_ids
        ):
            self.lifecycle_marker_job = None
            self.calls.append("lifecycle_reconcile")
            return True
        return False

    def prepare_target_override(self, _plan) -> None:
        self.calls.append("prepare_override")
        if self.fail_override:
            raise RuntimeError("forced durable override failure")
        self.pending_override = True

    def activate_target_override(self, _plan) -> None:
        self.calls.append("activate_override")
        if not self.pending_override:
            raise RuntimeError("pending override missing")
        self.pending_override = False
        self.active_target_override = True

    def updater_handoff_required(self, _plan) -> bool:
        return self.handoff

    def handoff_updater(self) -> None:
        self.calls.append("handoff")

    def backup_postgres(self, job_id: str) -> dict:
        self.calls.append("backup")
        self.backup_started.set()
        if self.backup_gate is not None:
            self.backup_gate.wait(timeout=4)
        return {"path": f"/{job_id}.dump", "sha256": "f" * 64, "bytes": 512, "database": "tlsoc", "user": "tlsoc", "verified": True}

    def quiesce_backend(self) -> None:
        self.calls.append("quiesce")
        if self.fail_quiesce:
            raise RuntimeError("forced writer quiesce failure")

    def switch_backend(self) -> None:
        self.calls.append("switch_backend")

    def verify_backend(self, _plan) -> None:
        self.calls.append("verify_backend")
        if self.fail_backend:
            raise RuntimeError("forced backend readiness failure")

    def switch_webui(self) -> None:
        self.calls.append("switch_webui")

    def verify_webui(self, _plan) -> None:
        self.calls.append("verify_webui")
        if self.fail_webui:
            raise RuntimeError("forced Web readiness failure")

    def observe(self, _plan) -> None:
        self.calls.append("observe")
        self.current_identity = {
            "version": "0.1.3",
            "channel": "stable",
            "commit_sha": TARGET_SHA,
            "state_schema": "1",
            "backend_image_id": f"sha256:{'1' * 64}",
            "webui_image_id": f"sha256:{'2' * 64}",
        }

    def rollback(self, _snapshot, _backup, *, restore_database: bool) -> None:
        self.calls.append(f"rollback:{restore_database}")
        self.rollback_calls += 1
        if self.fail_rollback:
            raise RuntimeError("forced rollback failure")
        self.pending_override = False
        self.active_target_override = False
        self.current_identity = {
            "version": str(_snapshot.get("version", "0.1.2")),
            "channel": str(_snapshot.get("channel", "stable")),
            "commit_sha": str(_snapshot.get("commit_sha", CURRENT_SHA)),
            "state_schema": str(_snapshot.get("state_schema", "1")),
            "backend_image_id": str(_snapshot.get("backend_image_id")),
            "webui_image_id": str(_snapshot.get("webui_image_id")),
        }


class UpdaterTestService(UpdateService):
    def __init__(self, store: JsonStore, runtime: FakeRuntime) -> None:
        super().__init__(store, runtime, REPOSITORY)  # type: ignore[arg-type]

    def _load_verified_plan(self, release: dict[str, str], *, refresh: bool):
        self.runtime.verify_plan_signature(None, None, release["tag"])
        result = validate_plan(plan_dict(), REPOSITORY)
        self.runtime.verify_image_signatures(result)
        return result


def wait_job(service: UpdateService, job_id: str, statuses: set[str] = TERMINAL_STATUSES) -> dict:
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        job = service.store.load_job(job_id)
        if job and job.get("status") in statuses:
            # Exercise the operator-visible boundary before returning private
            # durable fields used by state-machine assertions. This also joins
            # the worker tail so TemporaryDirectory cleanup cannot race it.
            service.get_job(job_id)
            return service.store.load_job(job_id) or job
        time.sleep(0.01)
    raise AssertionError(f"job {job_id} did not reach {statuses}")


class ContractTests(unittest.TestCase):
    def test_bootstrap_reuses_only_ready_compatible_idle_supervisor(self) -> None:
        status = {
            "available": True,
            "protocol_version": 1,
            "updater_version": "0.1.10",
            "state": "ready",
            "active_job": None,
            "capabilities": {
                "preflight": True,
                "start": True,
                "cancel": True,
                "rollback": True,
            },
        }
        self.assertEqual(replacement_decision(status), "reuse")
        self.assertEqual(replacement_decision(status, "0.1.10"), "reuse")
        self.assertEqual(replacement_decision(status, "0.1.8"), "replace")
        self.assertEqual(
            replacement_decision({**status, "updater_version": None}, "0.1.10"),
            "replace",
        )
        self.assertEqual(
            replacement_decision({**status, "protocol_version": 0}), "replace"
        )
        with self.assertRaisesRegex(BootstrapStatusError, "active job"):
            replacement_decision(
                {**status, "state": "busy", "active_job": {"job_id": "update-1"}}
            )
    def test_plan_accepts_only_fixed_digest_pinned_components(self) -> None:
        plan = validate_plan(plan_dict(), REPOSITORY)
        self.assertEqual(plan.version, "0.1.3")
        self.assertEqual(set(plan.components), {"updater", "backend", "webui"})

    def test_plan_rejects_unknown_commands_and_mutable_images(self) -> None:
        bad = plan_dict()
        bad["commands"] = ["docker system prune"]
        with self.assertRaises(ContractError):
            validate_plan(bad, REPOSITORY)

    def test_plan_rejects_newer_required_updater_protocol(self) -> None:
        bad = plan_dict()
        bad["compatibility"]["minimum_updater_protocol"] = 2
        with self.assertRaisesRegex(ContractError, "requires updater protocol 2"):
            validate_plan(bad, REPOSITORY)
        bad = plan_dict()
        bad["components"]["backend"]["image"] = "ghcr.io/arydestroyer/kavach-agenticsoc/backend:latest"
        with self.assertRaises(ContractError):
            validate_plan(bad, REPOSITORY)

    def test_release_request_rejects_browser_selected_asset_url(self) -> None:
        release = release_dict()
        release["plan_url"] = "https://example.com/upgrade-plan.json"
        with self.assertRaises(ContractError):
            validate_release_request(release, REPOSITORY)

    def test_release_plan_builder_emits_protocol_and_digest_pins(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "upgrade-plan.json"
            command = [
                sys.executable,
                str(ROOT / "scripts" / "build_upgrade_plan.py"),
                "--version", "0.1.3",
                "--tag", "v0.1.3",
                "--commit-sha", TARGET_SHA,
                "--published-at", "2026-08-03T00:00:00Z",
                "--repository", REPOSITORY,
                "--updater-image", f"ghcr.io/arydestroyer/kavach-agenticsoc/updater@sha256:{'a' * 64}",
                "--backend-image", f"ghcr.io/arydestroyer/kavach-agenticsoc/backend@sha256:{'b' * 64}",
                "--webui-image", f"ghcr.io/arydestroyer/kavach-agenticsoc/webui@sha256:{'c' * 64}",
                "--output", str(output),
            ]
            subprocess.run(command, cwd=ROOT, check=True, capture_output=True)
            generated = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(
                generated["compatibility"]["minimum_updater_protocol"], 1
            )
            self.assertEqual(
                generated["compatibility"]["from"]["min_inclusive"], "0.1.1"
            )
            # A 0.2.x install must accept the next 0.2 patch plan.
            self.assertEqual(
                generated["compatibility"]["from"]["max_exclusive"], "0.3.0"
            )
            self.assertTrue(
                all(
                    component["image"].endswith(component["digest"])
                    for component in generated["components"].values()
                )
            )

    def test_sequential_patch_plans_share_the_pinned_v1_compose_base(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            generated_plans = []
            for version, target_sha in (
                ("0.1.3", "2" * 40),
                ("0.1.4", "3" * 40),
            ):
                output = Path(directory) / f"upgrade-plan-{version}.json"
                command = [
                    sys.executable,
                    str(ROOT / "scripts" / "build_upgrade_plan.py"),
                    "--version", version,
                    "--tag", f"v{version}",
                    "--commit-sha", target_sha,
                    "--published-at", "2026-08-03T00:00:00Z",
                    "--repository", REPOSITORY,
                    "--updater-image", f"ghcr.io/arydestroyer/kavach-agenticsoc/updater@sha256:{'a' * 64}",
                    "--backend-image", f"ghcr.io/arydestroyer/kavach-agenticsoc/backend@sha256:{'b' * 64}",
                    "--webui-image", f"ghcr.io/arydestroyer/kavach-agenticsoc/webui@sha256:{'c' * 64}",
                    "--output", str(output),
                ]
                subprocess.run(command, cwd=ROOT, check=True, capture_output=True)
                generated_plans.append(json.loads(output.read_text(encoding="utf-8")))

            expected = hashlib.sha256(
                (ROOT / "deploy" / "docker-compose.agnostic.yml").read_bytes()
            ).hexdigest()
            self.assertEqual(
                [
                    plan["compatibility"]["compose_sha256"]
                    for plan in generated_plans
                ],
                [expected, expected],
            )


class RecordingRunner:
    def __init__(self) -> None:
        self.calls: list[dict] = []

    def run(
        self,
        command: list[str],
        *,
        timeout: int = 300,
        input_data: bytes | None = None,
        stdin_file=None,
        stdout_file=None,
    ) -> subprocess.CompletedProcess[bytes]:
        self.calls.append(
            {
                "command": list(command),
                "timeout": timeout,
                "input_data": input_data,
                "stdin_file": stdin_file is not None,
                "stdout_file": stdout_file is not None,
            }
        )
        if "pg_dump" in command and stdout_file is not None:
            stdout_file.write(b"PGDMP" + b"x" * 251)
        return subprocess.CompletedProcess(command, 0, stdout=b"", stderr=b"")


class RuntimeHarness(ComposeRuntime):
    def __init__(self, config: RuntimeConfig, runner: RecordingRunner) -> None:
        super().__init__(config, runner)  # type: ignore[arg-type]
        self.compose_calls: list[tuple[str, ...]] = []
        self.health_calls: list[str] = []

    def _container(self, name: str) -> dict:
        service = name
        labels = {
            "com.docker.compose.project": self.config.project_name,
            "com.docker.compose.service": service,
            "com.docker.compose.container-number": "1",
        }
        common = {
            "Image": f"sha256:{'f' * 64}",
            "State": {"Running": True, "Health": {"Status": "healthy"}},
            "NetworkSettings": {
                "Networks": {f"{self.config.project_name}_default": {}}
            },
        }
        if name == self.config.postgres_container:
            return {
                **common,
                "Config": {
                    "Env": ["POSTGRES_USER=tlsoc", "POSTGRES_DB=tlsoc"],
                    "Labels": labels,
                },
                "Mounts": [
                    {
                        "Type": "volume",
                        "Name": f"{self.config.project_name}_tlsoc-pgdata",
                        "Destination": "/var/lib/postgresql/data",
                    }
                ],
            }
        return {
            **common,
            "Config": {
                "Labels": labels,
                "Env": ["STATE_BACKEND=postgres"]
                if name == self.config.backend_container
                else [],
            },
        }

    def _compose(self, *args: str, timeout: int = 600):
        self.compose_calls.append(tuple(args))
        return subprocess.CompletedProcess(list(args), 0, stdout=b"", stderr=b"")

    def _wait_health(self, container: str, timeout_seconds: int) -> None:
        self.health_calls.append(container)

    def installed_identity(self) -> dict[str, str]:
        return {
            "version": "0.1.2",
            "channel": "stable",
            "commit_sha": CURRENT_SHA,
            "state_schema": "1",
            "backend_image_id": f"sha256:{'d' * 64}",
            "webui_image_id": f"sha256:{'e' * 64}",
        }


class RuntimeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.compose = root / "docker-compose.yml"
        self.environment = root / ".env"
        self.compose.write_text("services: {}\n", encoding="utf-8")
        self.environment.write_text("TLSOC_PG_PASSWORD=test\n", encoding="utf-8")
        self.config = RuntimeConfig(
            trusted_repository=REPOSITORY,
            compose_file=self.compose,
            env_file=self.environment,
            state_dir=root / "state",
            backup_dir=root / "backups",
            host_override_file=root / "host-runtime" / "active-release.compose.yml",
        )
        self.config.state_dir.mkdir()
        self.runner = RecordingRunner()
        self.runtime = RuntimeHarness(self.config, self.runner)

    def test_command_runner_rejects_two_input_sources_before_execution(self) -> None:
        with self.assertRaises(RuntimeFailure):
            CommandRunner().run(
                ["true"], input_data=b"payload", stdin_file=io.BytesIO(b"payload")
            )

    def test_installed_identity_requires_matching_channel_and_immutable_image_ids(
        self,
    ) -> None:
        labels = {
            "org.opencontainers.image.version": "0.1.2",
            "org.opencontainers.image.revision": CURRENT_SHA,
            "dev.tlsoc.release.channel": "stable",
            "io.agentic-soc.state.schema": "1",
        }
        containers = {
            self.config.backend_container: {
                "Image": f"sha256:{'d' * 64}",
                "Config": {"Labels": labels},
            },
            self.config.webui_container: {
                "Image": f"sha256:{'e' * 64}",
                "Config": {"Labels": {**labels, "dev.tlsoc.release.channel": "testing"}},
            },
        }
        runtime = ComposeRuntime(self.config, self.runner)
        runtime._container = lambda name: containers[name]  # type: ignore[method-assign]

        with self.assertRaisesRegex(RuntimeFailure, "identities disagree"):
            runtime.installed_identity()

        containers[self.config.webui_container]["Config"]["Labels"] = labels
        containers[self.config.webui_container]["Image"] = "mutable-web-image"
        with self.assertRaisesRegex(RuntimeFailure, "immutable image ID"):
            runtime.installed_identity()

    def test_installed_identity_accepts_matching_missing_legacy_schema_labels(
        self,
    ) -> None:
        legacy_labels = {
            "org.opencontainers.image.version": "0.1.1",
            "org.opencontainers.image.revision": CURRENT_SHA,
            "dev.tlsoc.release.channel": "stable",
        }
        containers = {
            self.config.backend_container: {
                "Image": f"sha256:{'d' * 64}",
                "Config": {"Labels": legacy_labels},
            },
            self.config.webui_container: {
                "Image": f"sha256:{'e' * 64}",
                "Config": {"Labels": legacy_labels},
            },
        }
        runtime = ComposeRuntime(self.config, self.runner)
        runtime._container = lambda name: containers[name]  # type: ignore[method-assign]

        identity = runtime.installed_identity()

        self.assertEqual(identity["version"], "0.1.1")
        self.assertEqual(identity["state_schema"], "unknown")

        containers[self.config.webui_container]["Config"]["Labels"] = {
            **legacy_labels,
            "io.agentic-soc.state.schema": "1",
        }
        with self.assertRaisesRegex(RuntimeFailure, "identities disagree"):
            runtime.installed_identity()

    def test_preflight_requires_managed_stable_identity_after_v011(self) -> None:
        self.environment.write_text(
            "TLSOC_AUTH_ENABLED=true\n"
            f"TLSOC_AUTH_JWT_SECRET={'a' * 32}\n"
            "TLSOC_PG_PASSWORD=test\n",
            encoding="utf-8",
        )
        raw = plan_dict()
        raw["compatibility"]["compose_sha256"] = hashlib.sha256(
            self.compose.read_bytes()
        ).hexdigest()
        plan = validate_plan(raw, REPOSITORY)
        self.runtime.installed_identity = lambda: {  # type: ignore[method-assign]
            "version": "0.1.2",
            "channel": "testing",
            "commit_sha": "unknown",
            "state_schema": "unknown",
            "backend_image_id": f"sha256:{'d' * 64}",
            "webui_image_id": f"sha256:{'e' * 64}",
        }

        report = self.runtime.preflight(plan)

        managed = next(
            check
            for check in report["checks"]
            if check["code"] == "managed_stable_identity"
        )
        self.assertEqual(managed["status"], "fail")
        self.assertIn(
            "managed_stable_identity",
            {blocker["code"] for blocker in report["blockers"]},
        )

    def test_preflight_preserves_one_time_v011_host_bootstrap(self) -> None:
        self.environment.write_text(
            "TLSOC_AUTH_ENABLED=true\n"
            f"TLSOC_AUTH_JWT_SECRET={'a' * 32}\n"
            "TLSOC_PG_PASSWORD=test\n",
            encoding="utf-8",
        )
        raw = plan_dict()
        raw["compatibility"]["from"]["min_inclusive"] = "0.1.1"
        raw["compatibility"]["compose_sha256"] = hashlib.sha256(
            self.compose.read_bytes()
        ).hexdigest()
        plan = validate_plan(raw, REPOSITORY)
        self.runtime.installed_identity = lambda: {  # type: ignore[method-assign]
            "version": "0.1.1",
            "channel": "testing",
            "commit_sha": "unknown",
            "state_schema": "unknown",
            "backend_image_id": f"sha256:{'d' * 64}",
            "webui_image_id": f"sha256:{'e' * 64}",
        }

        report = self.runtime.preflight(plan)

        managed = next(
            check
            for check in report["checks"]
            if check["code"] == "managed_stable_identity"
        )
        self.assertEqual(managed["status"], "pass")
        self.assertIn(
            "legacy_bootstrap_identity",
            {warning["code"] for warning in report["warnings"]},
        )

    def test_same_v1_base_preflights_two_sequential_patch_updates(self) -> None:
        self.environment.write_text(
            "TLSOC_AUTH_ENABLED=true\n"
            f"TLSOC_AUTH_JWT_SECRET={'a' * 32}\n"
            "TLSOC_PG_PASSWORD=test\n",
            encoding="utf-8",
        )
        compose_sha = hashlib.sha256(self.compose.read_bytes()).hexdigest()
        installed = {"version": "0.1.2", "commit_sha": CURRENT_SHA}
        recorded_run = self.runner.run

        def run_with_capacity(command, **kwargs):
            result = recorded_run(command, **kwargs)
            if command[-3:] == ["du", "-sb", "/var/lib/postgresql/data"]:
                result.stdout = b"1024\t/var/lib/postgresql/data\n"
            return result

        self.runner.run = run_with_capacity  # type: ignore[method-assign]
        disk_capacity = mock.patch(
            "agentic_soc_updater.runtime.shutil.disk_usage",
            return_value=mock.Mock(free=1024 * 1024 * 1024),
        )
        disk_capacity.start()
        self.addCleanup(disk_capacity.stop)
        self.runtime.installed_identity = lambda: {  # type: ignore[method-assign]
            "version": installed["version"],
            "channel": "stable",
            "commit_sha": installed["commit_sha"],
            "state_schema": "1",
            "backend_image_id": f"sha256:{'d' * 64}",
            "webui_image_id": f"sha256:{'e' * 64}",
        }

        for version, target_sha in (("0.1.3", "2" * 40), ("0.1.4", "3" * 40)):
            raw = plan_dict()
            raw["release"].update(
                version=version,
                tag=f"v{version}",
                commit_sha=target_sha,
            )
            raw["compatibility"]["compose_sha256"] = compose_sha
            for component in raw["components"].values():
                component["labels"].update(
                    {
                        "org.opencontainers.image.version": version,
                        "org.opencontainers.image.revision": target_sha,
                    }
                )
            report = self.runtime.preflight(validate_plan(raw, REPOSITORY))
            self.assertEqual(report["blockers"], [], report)
            canonical = next(
                check
                for check in report["checks"]
                if check["code"] == "canonical_compose"
            )
            self.assertEqual(canonical["status"], "pass")
            installed.update(version=version, commit_sha=target_sha)

    def test_backup_streams_archive_to_documented_pg_restore_stdin(self) -> None:
        backup = self.runtime.backup_postgres("update-123")
        self.assertTrue(backup["verified"])
        restore_call = next(call for call in self.runner.calls if "pg_restore" in call["command"])
        self.assertEqual(restore_call["command"][-2:], ["pg_restore", "--list"])
        self.assertTrue(restore_call["stdin_file"])
        self.assertIsNone(restore_call["input_data"])

    def test_rollback_retains_serving_updater_and_streams_atomic_restore(self) -> None:
        plan = validate_plan(plan_dict(), REPOSITORY)
        self.runtime.prepare_target_override(plan)
        backup = self.runtime.backup_postgres("update-rollback")
        backup["writer_quiesced"] = True
        snapshot = {
            "backend_image_id": f"sha256:{'d' * 64}",
            "webui_image_id": f"sha256:{'e' * 64}",
            "version": "0.1.2",
            "commit_sha": CURRENT_SHA,
        }
        self.runtime.rollback(snapshot, backup, restore_database=True)
        override = self.runtime.override_file.read_text(encoding="utf-8")
        self.assertIn(f"sha256:{'f' * 64}", override)
        self.assertIn(snapshot["backend_image_id"], override)
        self.assertEqual(
            override,
            self.config.host_override_file.read_text(encoding="utf-8"),
        )
        self.assertFalse(self.runtime.pending_override_file.exists())
        restore_call = [call for call in self.runner.calls if "pg_restore" in call["command"]][-1]
        self.assertTrue(restore_call["stdin_file"])
        self.assertNotIn("-", restore_call["command"])
        self.assertIn("--single-transaction", restore_call["command"])
        self.assertIn("--exit-on-error", restore_call["command"])

    def test_database_restore_rejects_non_quiesced_backup(self) -> None:
        plan = validate_plan(plan_dict(), REPOSITORY)
        self.runtime.prepare_target_override(plan)
        snapshot = {
            "backend_image_id": f"sha256:{'d' * 64}",
            "webui_image_id": f"sha256:{'e' * 64}",
            "version": "0.1.2",
            "commit_sha": CURRENT_SHA,
        }
        with self.assertRaises(RuntimeFailure):
            self.runtime.rollback(
                snapshot,
                {"verified": True, "path": "/not/read", "sha256": "f" * 64},
                restore_database=True,
            )

    def test_target_override_is_private_until_explicit_activation(self) -> None:
        plan = validate_plan(plan_dict(), REPOSITORY)
        self.runtime.prepare_target_override(plan)
        self.assertTrue(self.runtime.pending_override_file.exists())
        self.assertFalse(self.runtime.override_file.exists())
        self.assertFalse(self.config.host_override_file.exists())

        pre_activation_runtime = ComposeRuntime(
            self.config, self.runner
        )  # type: ignore[arg-type]
        pre_activation_runtime._compose("ps")
        self.assertNotIn(
            str(self.runtime.pending_override_file),
            self.runner.calls[-1]["command"],
        )
        self.assertNotIn("--file", self.runner.calls[-1]["command"][9:])

        self.runtime.activate_target_override(plan)
        base_runtime = ComposeRuntime(self.config, self.runner)  # type: ignore[arg-type]
        base_runtime._compose("up", "--no-build", "tlsoc-backend")
        command = self.runner.calls[-1]["command"]
        self.assertEqual(
            command[:9],
            [
                "docker", "compose", "--project-name", "tlsoc-agentic-soc",
                "--env-file", str(self.environment), "--file", str(self.compose),
                "--file",
            ],
        )
        self.assertEqual(command[9], str(self.runtime.override_file))
        self.assertEqual(command[-3:], ["up", "--no-build", "tlsoc-backend"])
        self.assertEqual(
            self.runtime.override_file.read_text(encoding="utf-8"),
            self.config.host_override_file.read_text(encoding="utf-8"),
        )
        self.assertFalse(self.runtime.pending_override_file.exists())
        self.assertEqual(self.config.host_override_file.stat().st_mode & 0o777, 0o644)

    def test_lifecycle_wrapper_is_valid_shell(self) -> None:
        path = ROOT / "scripts" / "agentic-soc-compose.sh"
        result = subprocess.run(["bash", "-n", str(path)], capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr.decode("utf-8", "replace"))
        source = path.read_text(encoding="utf-8")
        self.assertIn('TLSOC_VERSION="$(tr -d', source)
        self.assertIn("export TLSOC_VERSION", source)
        self.assertIn("build|--build)", source)
        self.assertIn("signed release override is active", source)
        self.assertIn("compose_lifecycle_guard.py", source)

    def test_lifecycle_guard_blocks_mutating_compose_while_update_marker_exists(
        self,
    ) -> None:
        guard = ROOT / "scripts" / "compose_lifecycle_guard.py"
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            marker = root / "update-active.json"
            marker.write_text('{"job_id":"update-active"}\n', encoding="utf-8")
            invoked = root / "invoked"
            fake = root / "fake-docker"
            fake.write_text(
                "#!/bin/sh\nprintf invoked > \"$AGENTIC_SOC_GUARD_SENTINEL\"\n",
                encoding="utf-8",
            )
            fake.chmod(0o755)
            environment = {
                **os.environ,
                "AGENTIC_SOC_GUARD_SENTINEL": str(invoked),
            }
            blocked = subprocess.run(
                [
                    sys.executable,
                    str(guard),
                    str(root),
                    "--",
                    "1",
                    str(fake),
                    "compose",
                    "up",
                ],
                env=environment,
                capture_output=True,
                check=False,
            )
            self.assertEqual(blocked.returncode, 4)
            self.assertFalse(invoked.exists())
            self.assertIn(b"supervised update is active", blocked.stderr)

            allowed = subprocess.run(
                [
                    sys.executable,
                    str(guard),
                    str(root),
                    "--",
                    "1",
                    str(fake),
                    "compose",
                    "ps",
                ],
                env=environment,
                capture_output=True,
                check=False,
            )
            self.assertEqual(allowed.returncode, 0, allowed.stderr)
            self.assertTrue(invoked.exists())

    def test_terminal_lifecycle_marker_is_reconciled_only_from_durable_truth(
        self,
    ) -> None:
        job_id = "update-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        self.runtime.begin_lifecycle(job_id)
        self.runtime.release_lifecycle(job_id, terminal=False)
        self.assertTrue(self.runtime.lifecycle_marker_file.exists())

        restarted = ComposeRuntime(self.config, self.runner)
        self.assertFalse(restarted.reconcile_terminal_lifecycle(set()))
        self.assertTrue(restarted.lifecycle_marker_file.exists())
        self.assertTrue(restarted.reconcile_terminal_lifecycle({job_id}))
        self.assertFalse(restarted.lifecycle_marker_file.exists())

        restarted.lifecycle_marker_file.write_text(
            "not-json\n", encoding="utf-8"
        )
        self.assertFalse(restarted.reconcile_terminal_lifecycle({job_id}))
        self.assertTrue(restarted.lifecycle_marker_file.exists())

    def test_bootstrap_delegates_full_upgrade_to_signed_supervisor(self) -> None:
        path = ROOT / "scripts" / "bootstrap-updater.sh"
        result = subprocess.run(["bash", "-n", str(path)], capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr.decode("utf-8", "replace"))
        source = path.read_text(encoding="utf-8")
        self.assertIn("refs/tags/${tag}^{commit}", source)
        self.assertIn(
            'git merge-base --is-ancestor "${release_sha}" origin/main', source
        )
        self.assertNotIn(
            '"${release_sha}" == "$(git rev-parse origin/main)"', source
        )
        self.assertIn("/v1/preflight", source)
        self.assertIn("/v1/jobs", source)
        self.assertNotIn("--force-recreate tlsoc-backend", source)
        finalizer = source.partition("finalize_preserved_updater() {")[2].partition(
            "\n}\ntrap finalize_preserved_updater EXIT"
        )[0]
        self.assertLess(
            finalizer.index('if [[ "${supervisor_handoff_owned}" == true ]]'),
            finalizer.index(
                'mv "${preserved_override}" "${runtime_dir}/active-release.compose.yml"'
            ),
        )
        submission = 'job="$(updater_request POST /v1/jobs "${start_body}")"'
        self.assertLess(
            source.index("supervisor_handoff_owned=true"),
            source.index(submission),
        )
        self.assertIn(
            'bootstrap_start_key_file="${runtime_dir}/bootstrap-start-${release_sha}.key"',
            source,
        )
        self.assertIn("os.O_CREAT | os.O_EXCL", source)
        self.assertIn('"${bootstrap_start_key}" <<\'PY\'', source)
        self.assertGreaterEqual(source.count("retire_bootstrap_start_key"), 3)
        self.assertIn('if [[ "${result}" -eq 0 ]]', source)
        self.assertIn('rm -f -- "${preserved_override}"', source)
        self.assertIn("docker inspect --format '{{.Image}}' agentic-soc-updater", source)
        self.assertIn('[[ "${prior_updater_image}" =~ ^sha256:[0-9a-f]{64}$ ]]', source)
        self.assertIn('"    image: ${prior_updater_image}" > "${recovery_temp}"', source)
        self.assertIn(
            'mv "${preserved_override}" "${runtime_dir}/active-release.compose.yml"',
            source,
        )
        self.assertLess(
            source.index(
                'mv "${runtime_dir}/active-release.compose.yml" "${preserved_override}"'
            ),
            source.index('"${compose_wrapper}" up --detach --build'),
        )
        self.assertLess(
            source.index("docker inspect --format '{{.Image}}' agentic-soc-updater"),
            source.index('"${compose_wrapper}" up --detach --build'),
        )
        self.assertNotIn("updater_compose_args=()", source)
        self.assertNotIn('"${updater_compose_args[@]}"', source)
        self.assertIn(
            '"${compose_wrapper}" up --detach --build "$@" agentic-soc-updater',
            source,
        )
        self.assertIn(
            'python3 - "${existing_status}" "${version}"',
            source,
        )
        self.assertIn(
            'replacement_decision(json.loads(sys.argv[1]), sys.argv[2])',
            source,
        )
        self.assertIn("start_updater --force-recreate", source)
        self.assertRegex(source, r"(?m)^\s+start_updater$")
        self.assertIn("Bash 3.2", source)

    def test_release_retry_stages_and_recovers_only_an_exact_draft(self) -> None:
        source = (ROOT / ".github" / "workflows" / "release.yml").read_text(
            encoding="utf-8"
        )
        inspection = source.partition(
            "- name: Inspect and safely recover an exact draft release"
        )[2].partition("\n      - ")[0]
        self.assertIn("scripts/release_asset_state.py", inspection)
        self.assertIn("--paginate --slurp", inspection)
        self.assertIn(".delete_asset_ids[]", inspection)
        self.assertIn("== draft", inspection)
        self.assertIn("releases/assets/${asset_id}", inspection)
        self.assertIn('echo "release_state=${release_state}"', inspection)
        self.assertIn('echo "release_exists=${release_exists}"', inspection)
        self.assertIn('echo "release_id=${release_id}"', inspection)
        for field in ("release_exists", "plan_exists", "bundle_exists"):
            self.assertIn("scripts/read_release_state_boolean.py", inspection)
            self.assertIn(f"--field {field}", inspection)
        self.assertNotIn("jq -er '.release_exists'", inspection)
        self.assertNotIn("jq -er '.plan_exists'", inspection)
        self.assertNotIn("jq -er '.bundle_exists'", inspection)

        generation = source.partition(
            "- name: Generate the declarative upgrade plan when absent"
        )[2].partition("\n      - name:")[0]
        self.assertIn(
            "if: steps.assets.outputs.plan_exists != 'true'", generation
        )

        publication = source.partition(
            "- name: Stage, verify, and atomically publish the GitHub Release"
        )[2]
        self.assertIn("EXPECTED_RELEASE_STATE", publication)
        self.assertIn("Release state changed after inspection", publication)
        for field in ("plan_exists", "bundle_exists"):
            self.assertIn("scripts/read_release_state_boolean.py", publication)
            self.assertIn(f"--field {field}", publication)
        self.assertNotIn("jq -er '.plan_exists'", publication)
        self.assertNotIn("jq -er '.bundle_exists'", publication)
        self.assertIn("agentic-soc-release-commit:${GITHUB_SHA}", publication)
        self.assertIn("draft:true", publication)
        self.assertNotIn("--clobber", publication)
        first_upload = publication.index('gh release upload "${tag}" upgrade-plan.json')
        second_upload = publication.index(
            'gh release upload "${tag}" upgrade-plan.sigstore.json'
        )
        verify = publication.index("cosign verify-blob")
        publish = publication.index("-F draft=false")
        self.assertLess(first_upload, second_upload)
        self.assertLess(second_upload, verify)
        self.assertLess(verify, publish)
        self.assertIn('.release_state == "published"', publication)
        tag_gate = source.partition(
            "- name: Prove immutable tag, exact main commit, and canonical version"
        )[2].partition("\n      - name:")[0]
        self.assertIn('git ls-remote origin "refs/tags/${tag}"', tag_gate)
        self.assertIn('git ls-remote origin "refs/tags/${tag}^{}"', tag_gate)

    def test_release_rerun_reuses_exact_successful_tag_ci_without_time_window(self) -> None:
        source = (ROOT / ".github" / "workflows" / "release.yml").read_text(
            encoding="utf-8"
        )
        gate = source.partition(
            "- name: Require the exact tag CI run and its fail-closed aggregate"
        )[2].partition("\n      - name:")[0]
        self.assertIn(
            '.event == "push" and .head_sha == $sha and .head_branch == $tag', gate
        )
        self.assertIn(
            '.status == "completed" and .conclusion == "success"', gate
        )
        self.assertIn("| sort_by(.run_started_at, .id)", gate)
        self.assertIn(
            '.name == "CI passed" and .status == "completed"', gate
        )
        self.assertNotIn("release_created_at", gate)
        self.assertNotIn("fromdateiso8601", gate)
        self.assertNotIn("$delta >= -300", gate)

    def test_release_anonymous_gate_does_not_overwrite_one_digest_between_platforms(
        self,
    ) -> None:
        source = (ROOT / ".github" / "workflows" / "release.yml").read_text(
            encoding="utf-8"
        )
        gate = source.partition(
            "- name: Prove anonymous pullability and exact OCI release labels"
        )[2].partition("\n      - name:")[0]

        self.assertIn("for platform in linux/amd64 linux/arm64", gate)
        pull = 'docker pull --platform "${platform}" "${reference}"'
        eviction = 'docker image rm "${reference}"'
        self.assertIn(pull, gate)
        self.assertIn(eviction, gate)
        self.assertLess(gate.index(pull), gate.index(eviction))
        self.assertIn(
            'EXPECTED_PLATFORMS = {("linux", "amd64"), ("linux", "arm64")}',
            gate,
        )
        self.assertIn("require_digest(raw_index, digest", gate)
        self.assertIn("raw_manifest, _ = fetch(", gate)
        self.assertIn("manifest_digest,", gate)
        self.assertIn("raw_config, _ = fetch(", gate)
        self.assertIn("config_digest,", gate)
        self.assertIn("anonymous GHCR token unavailable", gate)
        self.assertIn("OCI label mismatch", gate)

    def test_self_handoff_reuses_named_volume_name_not_engine_data_path(self) -> None:
        volume = {
            "Type": "volume",
            "Name": "tlsoc-agentic-soc_agentic-soc-updater-state",
            "Source": "/var/lib/docker/volumes/tlsoc-agentic-soc_agentic-soc-updater-state/_data",
            "Destination": "/var/lib/agentic-soc-updater",
            "RW": True,
        }
        spec = ComposeRuntime._handoff_mount_spec(
            volume, "/var/lib/agentic-soc-updater"
        )
        self.assertIn("src=tlsoc-agentic-soc_agentic-soc-updater-state", spec)
        self.assertNotIn("/var/lib/docker/volumes", spec)

    def test_self_handoff_bind_mount_requires_absolute_source(self) -> None:
        with self.assertRaises(RuntimeFailure):
            ComposeRuntime._handoff_mount_spec(
                {"Type": "bind", "Source": "relative/.env", "RW": False},
                "/deployment/.env",
            )

    def test_self_handoff_helper_is_valid_and_restores_old_container_on_failure(self) -> None:
        script = ComposeRuntime._handoff_helper_script()
        parsed = subprocess.run(
            ["/bin/sh", "-n"], input=script.encode("utf-8"), capture_output=True
        )
        self.assertEqual(parsed.returncode, 0, parsed.stderr.decode("utf-8", "replace"))
        self.assertIn('docker rename "$active" "$previous"', script)
        self.assertIn('docker start "$active"', script)
        self.assertIn("restore_previous", script)
        self.assertIn('docker update --restart=no "$helper"', script)
        self.assertIn('if ! exists "$active"', script)

    def test_self_handoff_helper_container_is_restartable_not_ephemeral(self) -> None:
        source = inspect.getsource(ComposeRuntime.handoff_updater)
        self.assertIn('"--restart", "unless-stopped"', source)
        self.assertNotIn('"--rm"', source)

    def test_operator_docs_describe_restartable_idempotent_self_replacement(self) -> None:
        paths = (
            ROOT / "DEPLOY.md",
            ROOT / "docs" / "HANDOFF.md",
            ROOT / "docs" / "operations" / "deployment.md",
            ROOT / "docs" / "operations" / "upgrades.md",
            ROOT / "docs" / "releases" / "0.1.2.md",
            ROOT / "docs" / "releases" / "known-limitations.md",
            ROOT / "updater" / "README.md",
        )
        documentation = "\n".join(path.read_text(encoding="utf-8") for path in paths)
        for stale_claim in (
            "detached one-shot helper",
            "narrow self-handoff interval",
            "self-handoff gap",
        ):
            self.assertNotIn(stale_claim, documentation)
        self.assertIn("restartable helper", documentation)
        self.assertIn("idempotent", documentation)

    def test_rollback_uses_current_immutable_updater_image(self) -> None:
        self.assertFalse(self.runtime.override_file.exists())
        self.assertEqual(
            self.runtime._updater_image_for_rollback({}), f"sha256:{'f' * 64}"
        )


class StateMachineTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)

    def service(self, runtime: FakeRuntime) -> UpdaterTestService:
        return UpdaterTestService(JsonStore(Path(self.temp.name)), runtime)

    def preflight_and_start(
        self, service: UpdaterTestService, suffix: str = "0001"
    ) -> tuple[dict, dict]:
        preflight = service.preflight(
            {
                "release": release_dict(),
                "idempotency_key": f"preflight-key-{suffix}",
            }
        )
        job = service.start(
            {
                "release": release_dict(),
                "preflight_token": preflight["preflight_token"],
                "idempotency_key": f"start-key-{suffix}",
            }
        )
        return preflight, job

    def test_success_receipt_and_wire_models(self) -> None:
        runtime = FakeRuntime()
        service = self.service(runtime)
        preflight, started = self.preflight_and_start(service)
        self.assertEqual(preflight["backup"]["state"], "planned")
        self.assertEqual(preflight["rollback"]["state"], "planned")
        self.assertFalse(preflight["backup"]["verified"])
        terminal = wait_job(service, started["job_id"])
        self.assertEqual(terminal["status"], "succeeded")
        self.assertEqual(terminal["stage"], "completed")
        self.assertEqual(service.receipt(started["job_id"])["after"]["version"], "0.1.3")
        self.assertLess(runtime.calls.index("quiesce"), runtime.calls.index("backup"))
        self.assertLess(
            runtime.calls.index("backup"), runtime.calls.index("activate_override")
        )
        self.assertLess(
            runtime.calls.index("activate_override"),
            runtime.calls.index("switch_backend"),
        )
        self.assertLess(runtime.calls.index("backup"), runtime.calls.index("switch_backend"))
        self.assertIsNone(runtime.lifecycle_marker_job)

        # Parse exactly through the backend contract used by the same-origin API.
        from app.engine.update_supervisor import UpdateJob, UpdatePreflight, UpdateReceipt

        UpdatePreflight.model_validate(preflight)
        UpdateJob.model_validate(service.get_job(started["job_id"]))
        UpdateReceipt.model_validate(service.receipt(started["job_id"]))

    def test_target_application_override_cannot_activate_while_backup_is_running(
        self,
    ) -> None:
        backup_gate = threading.Event()
        runtime = FakeRuntime(backup_gate=backup_gate)
        service = self.service(runtime)
        _preflight, started = self.preflight_and_start(
            service, "override-backup-boundary-0001"
        )
        self.assertTrue(runtime.backup_started.wait(timeout=4))

        # The target updater may already be prepared for handoff, but neither
        # updater-internal nor host-wrapper Compose can see target app pins.
        self.assertTrue(runtime.pending_override)
        self.assertFalse(runtime.active_target_override)
        self.assertNotIn("activate_override", runtime.calls)
        self.assertNotIn("switch_backend", runtime.calls)
        self.assertEqual(runtime.lifecycle_marker_job, started["job_id"])

        backup_gate.set()
        terminal = wait_job(service, started["job_id"])
        self.assertEqual(terminal["status"], "succeeded")
        self.assertLess(
            runtime.calls.index("backup"), runtime.calls.index("activate_override")
        )

    def test_runtime_drift_after_preflight_fails_before_host_mutation(self) -> None:
        runtime = FakeRuntime()
        service = self.service(runtime)
        preflight = service.preflight(
            {"release": release_dict(), "idempotency_key": "preflight-drift-0001"}
        )
        runtime.preflight = lambda _plan: {  # type: ignore[method-assign]
            "checks": [],
            "blockers": [
                {
                    "code": "managed_stable_identity",
                    "message": "installed release identity changed",
                    "remediation": "Run host bootstrap from a supported Stable release.",
                }
            ],
            "warnings": [],
            "current": {},
        }
        started = service.start(
            {
                "release": release_dict(),
                "preflight_token": preflight["preflight_token"],
                "idempotency_key": "start-drift-00000001",
            }
        )
        terminal = wait_job(service, started["job_id"])
        self.assertEqual(terminal["status"], "failed")
        self.assertIn("managed_stable_identity", terminal["error"]["message"])
        self.assertEqual(runtime.calls.count("verify_plan_signature"), 2)
        self.assertNotIn("pull", runtime.calls)
        self.assertNotIn("prepare_override", runtime.calls)
        self.assertNotIn("activate_override", runtime.calls)
        self.assertNotIn("quiesce", runtime.calls)
        self.assertNotIn("backup", runtime.calls)

    def test_runtime_drift_during_image_pull_fails_before_snapshot_or_mutation(
        self,
    ) -> None:
        pull_gate = threading.Event()
        runtime = FakeRuntime(pull_gate=pull_gate)
        service = self.service(runtime)
        _preflight, started = self.preflight_and_start(service)
        self.assertTrue(runtime.pull_started.wait(timeout=4))
        runtime.fingerprint_generation += 1
        pull_gate.set()
        terminal = wait_job(service, started["job_id"])
        self.assertEqual(terminal["status"], "failed")
        self.assertIn("changed while images were pulled", terminal["error"]["message"])
        self.assertNotIn("snapshot", terminal)
        self.assertNotIn("prepare_override", runtime.calls)
        self.assertNotIn("activate_override", runtime.calls)
        self.assertNotIn("quiesce", runtime.calls)
        self.assertNotIn("backup", runtime.calls)

    def test_forced_post_switch_failure_preserves_database_and_restores_images(self) -> None:
        runtime = FakeRuntime(fail_backend=True)
        service = self.service(runtime)
        _preflight, started = self.preflight_and_start(service)
        terminal = wait_job(service, started["job_id"])
        self.assertEqual(terminal["status"], "rolled_back")
        self.assertTrue(terminal["receipt"]["rollback_performed"])
        self.assertEqual(runtime.rollback_calls, 1)
        self.assertIn("rollback:False", runtime.calls)

    def test_cancel_wins_atomically_before_switch_boundary(self) -> None:
        runtime = FakeRuntime()
        service = self.service(runtime)
        entered = threading.Event()
        release = threading.Event()
        original_begin_switch = service._begin_switch

        def gated_begin_switch(job: dict) -> bool:
            entered.set()
            release.wait(timeout=4)
            return original_begin_switch(job)

        service._begin_switch = gated_begin_switch  # type: ignore[method-assign]
        _preflight, started = self.preflight_and_start(service)
        self.assertTrue(entered.wait(timeout=4))
        service.cancel(
            started["job_id"], {"idempotency_key": "cancel-switch-boundary-0001"}
        )
        release.set()
        terminal = wait_job(service, started["job_id"])
        self.assertEqual(terminal["status"], "cancelled")
        self.assertNotIn("switch_backend", runtime.calls)
        self.assertIn("rollback:False", runtime.calls)

    def test_failure_after_quiesce_before_switch_restarts_old_images_without_database_restore(self) -> None:
        runtime = FakeRuntime(fail_quiesce=True)
        service = self.service(runtime)
        _preflight, started = self.preflight_and_start(service)
        terminal = wait_job(service, started["job_id"])
        self.assertEqual(terminal["status"], "rolled_back")
        self.assertEqual(runtime.rollback_calls, 1)
        self.assertIn("rollback:False", runtime.calls)
        self.assertNotIn("backup", runtime.calls)

    def test_failure_after_web_switch_preserves_database_snapshot_as_recovery_artifact(self) -> None:
        runtime = FakeRuntime(fail_webui=True)
        service = self.service(runtime)
        _preflight, started = self.preflight_and_start(service)
        terminal = wait_job(service, started["job_id"])
        self.assertEqual(terminal["status"], "rolled_back")
        self.assertTrue(terminal["backup"]["writer_quiesced"])
        self.assertIn("rollback:False", runtime.calls)

    def test_cancel_while_quiesced_restarts_old_images_without_database_restore(self) -> None:
        gate = threading.Event()
        runtime = FakeRuntime(backup_gate=gate)
        service = self.service(runtime)
        _preflight, started = self.preflight_and_start(service)
        self.assertTrue(runtime.backup_started.wait(timeout=4))
        key = "cancel-after-quiesce-0001"
        requested = service.cancel(started["job_id"], {"idempotency_key": key})
        self.assertTrue(requested["message"].startswith("Cancellation"))
        gate.set()
        terminal = wait_job(service, started["job_id"])
        self.assertEqual(terminal["status"], "cancelled")
        self.assertIn("rollback:False", runtime.calls)
        retry = service.cancel(started["job_id"], {"idempotency_key": key})
        self.assertEqual(retry["status"], "cancelled")

    def test_self_handoff_is_durable_and_resumes_before_backup(self) -> None:
        runtime = FakeRuntime(handoff=True)
        service = self.service(runtime)
        _preflight, started = self.preflight_and_start(service)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            job = service.store.load_job(started["job_id"])
            if job and job.get("stage") == "quiescing":
                break
            time.sleep(0.01)
        else:
            self.fail("job did not persist updater handoff stage")
        self.assertNotIn("backup", runtime.calls)
        runtime.handoff = False
        resumed = UpdaterTestService(service.store, runtime)
        resumed.resume()
        terminal = wait_job(resumed, started["job_id"])
        self.assertEqual(terminal["status"], "succeeded")
        self.assertLess(runtime.calls.index("handoff"), runtime.calls.index("backup"))
        self.assertGreaterEqual(runtime.calls.count("verify_plan_signature"), 2)

    def test_resume_reconciles_only_a_marker_for_an_exact_terminal_job(self) -> None:
        runtime = FakeRuntime()
        service = self.service(runtime)
        terminal_job_id = "update-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        service.store.save_job(
            {
                "job_id": terminal_job_id,
                "status": "succeeded",
                "updated_at": "2026-08-03T00:00:00Z",
            }
        )
        runtime.lifecycle_marker_job = terminal_job_id
        service.resume()
        self.assertIsNone(runtime.lifecycle_marker_job)
        self.assertIn("lifecycle_reconcile", runtime.calls)

        runtime.lifecycle_marker_job = (
            "update-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
        )
        service.resume()
        self.assertEqual(
            runtime.lifecycle_marker_job,
            "update-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        )

    def test_resume_recovers_crash_after_queued_job_before_marker(self) -> None:
        runtime = FakeRuntime()
        service = self.service(runtime)
        job_id = "update-cccccccc-cccc-4ccc-8ccc-cccccccccccc"
        service.store.save_job(
            {
                "job_id": job_id,
                "release_id": "v0.1.3",
                "release": release_dict(),
                "status": "queued",
                "stage": "validating",
                "progress": 0,
                "message": "Update queued",
                "started_at": "2026-08-03T00:00:00Z",
                "updated_at": "2026-08-03T00:00:00Z",
                "cancel_requested": False,
                "switch_started": False,
                "plan": plan_dict(),
            }
        )
        self.assertIsNone(runtime.lifecycle_marker_job)

        restarted = UpdaterTestService(service.store, runtime)
        restarted.resume()
        terminal = wait_job(restarted, job_id)
        self.assertEqual(terminal["status"], "succeeded")
        self.assertIn("lifecycle_begin", runtime.calls)
        self.assertIsNone(runtime.lifecycle_marker_job)

    def test_terminal_status_is_not_published_before_lifecycle_cleanup(self) -> None:
        release_gate = threading.Event()
        runtime = FakeRuntime(release_gate=release_gate)
        service = self.service(runtime)
        _preflight, started = self.preflight_and_start(
            service, "terminal-publication-boundary-0001"
        )
        self.assertTrue(runtime.release_started.wait(timeout=4))

        # Durable terminal truth intentionally precedes marker removal for
        # crash recovery, but it must not yet be observable through the API.
        durable = service.store.load_job(started["job_id"])
        self.assertEqual(durable["status"], "succeeded")  # type: ignore[index]
        self.assertEqual(runtime.lifecycle_marker_job, started["job_id"])

        published: list[dict] = []
        reader_done = threading.Event()

        def read_public_job() -> None:
            published.append(service.get_job(started["job_id"]))
            reader_done.set()

        reader = threading.Thread(target=read_public_job)
        reader.start()
        self.assertFalse(reader_done.wait(timeout=0.1))

        release_gate.set()
        self.assertTrue(reader_done.wait(timeout=4))
        reader.join(timeout=4)
        self.assertFalse(reader.is_alive())
        self.assertEqual(published[0]["status"], "succeeded")
        self.assertIsNone(runtime.lifecycle_marker_job)

    def test_immediate_rollback_waits_for_success_worker_tail(self) -> None:
        runtime = FakeRuntime()
        service = self.service(runtime)
        terminal_saved = threading.Event()
        terminal_tail_gate = threading.Event()
        original_save_stage = service._save_stage

        def gated_save_stage(
            job: dict, stage: str, message: str, *, status: str = "running"
        ) -> None:
            original_save_stage(job, stage, message, status=status)
            if status == "succeeded" and not terminal_saved.is_set():
                terminal_saved.set()
                terminal_tail_gate.wait(timeout=4)

        service._save_stage = gated_save_stage  # type: ignore[method-assign]
        _preflight, started = self.preflight_and_start(
            service, "rollback-after-terminal-tail-0001"
        )
        self.assertTrue(terminal_saved.wait(timeout=4))
        self.assertIsNone(runtime.lifecycle_marker_job)

        rollback_result: list[dict] = []
        rollback_requested = threading.Event()

        def request_rollback() -> None:
            rollback_requested.set()
            rollback_result.append(
                service.request_rollback(
                    started["job_id"],
                    {"idempotency_key": "rollback-after-terminal-tail-0001"},
                )
            )

        requester = threading.Thread(target=request_rollback)
        requester.start()
        self.assertTrue(rollback_requested.wait(timeout=1))
        time.sleep(0.05)
        self.assertTrue(requester.is_alive())

        terminal_tail_gate.set()
        requester.join(timeout=4)
        self.assertFalse(requester.is_alive())
        self.assertEqual(rollback_result[0]["status"], "rolling_back")
        terminal = wait_job(service, started["job_id"], {"rolled_back", "failed"})
        self.assertEqual(terminal["status"], "rolled_back")
        self.assertIsNone(runtime.lifecycle_marker_job)

    def test_completed_workers_are_removed_from_the_registry(self) -> None:
        runtime = FakeRuntime()
        service = self.service(runtime)
        _preflight, started = self.preflight_and_start(
            service, "worker-registry-cleanup-0001"
        )

        self.assertEqual(wait_job(service, started["job_id"])["status"], "succeeded")
        self.assertNotIn(started["job_id"], service._workers)
        self.assertNotIn(started["job_id"], service._worker_modes)

    def test_worker_registration_and_thread_start_are_atomic(self) -> None:
        runtime = FakeRuntime()
        service = self.service(runtime)
        start_entered = threading.Event()
        allow_start = threading.Event()
        worker_entered = threading.Event()
        allow_worker_exit = threading.Event()
        start_calls: list[threading.Thread] = []
        start_calls_lock = threading.Lock()
        real_thread = threading.Thread

        class GatedStartThread(real_thread):
            def start(self) -> None:
                with start_calls_lock:
                    start_calls.append(self)
                start_entered.set()
                if not allow_start.wait(timeout=4):
                    raise AssertionError("test did not release Thread.start")
                super().start()

        def gated_worker(_job_id: str) -> None:
            worker_entered.set()
            if not allow_worker_exit.wait(timeout=4):
                raise AssertionError("test did not release updater worker")

        errors: list[BaseException] = []

        def launch() -> None:
            try:
                service._launch("atomic-worker-start-0001")
            except BaseException as exc:  # pragma: no cover - assertion aid
                errors.append(exc)

        with (
            mock.patch.object(service, "_worker", gated_worker),
            mock.patch("agentic_soc_updater.service.threading.Thread", GatedStartThread),
        ):
            first = real_thread(target=launch)
            second = real_thread(target=launch)
            first.start()
            self.assertTrue(start_entered.wait(timeout=1))
            second.start()
            time.sleep(0.05)
            self.assertEqual(len(start_calls), 1)

            allow_start.set()
            self.assertTrue(worker_entered.wait(timeout=1))
            first.join(timeout=4)
            second.join(timeout=4)
            self.assertFalse(first.is_alive())
            self.assertFalse(second.is_alive())
            self.assertEqual(errors, [])
            self.assertEqual(len(start_calls), 1)

            allow_worker_exit.set()
            deadline = time.monotonic() + 4
            while service._workers and time.monotonic() < deadline:
                time.sleep(0.01)

        self.assertNotIn("atomic-worker-start-0001", service._workers)
        self.assertNotIn("atomic-worker-start-0001", service._worker_modes)

    def test_failed_thread_start_removes_worker_registration(self) -> None:
        service = self.service(FakeRuntime())
        real_thread = threading.Thread

        class FailingStartThread(real_thread):
            def start(self) -> None:
                raise RuntimeError("synthetic thread start failure")

        with mock.patch(
            "agentic_soc_updater.service.threading.Thread", FailingStartThread
        ):
            with self.assertRaisesRegex(RuntimeError, "synthetic thread start failure"):
                service._launch("failed-worker-start-0001")

        self.assertNotIn("failed-worker-start-0001", service._workers)
        self.assertNotIn("failed-worker-start-0001", service._worker_modes)

    def test_concurrent_public_readers_wait_for_terminal_cleanup(self) -> None:
        release_gate = threading.Event()
        runtime = FakeRuntime(release_gate=release_gate)
        service = self.service(runtime)
        _preflight, started = self.preflight_and_start(
            service, "concurrent-terminal-readers-0001"
        )
        self.assertTrue(runtime.release_started.wait(timeout=4))

        readers = [
            lambda: service.get_job(started["job_id"]),
            service.status,
            lambda: terminal_page(service, MAX_TERMINAL_JOBS),
            lambda: service.receipt(started["job_id"]),
        ] * 4
        results: list[dict] = []
        errors: list[BaseException] = []

        def read(reader) -> None:
            try:
                results.append(reader())
            except BaseException as exc:  # pragma: no cover - assertion evidence
                errors.append(exc)

        threads = [threading.Thread(target=read, args=(reader,)) for reader in readers]
        for thread in threads:
            thread.start()
        time.sleep(0.1)
        self.assertTrue(all(thread.is_alive() for thread in threads))

        release_gate.set()
        for thread in threads:
            thread.join(timeout=4)
        self.assertTrue(all(not thread.is_alive() for thread in threads))
        self.assertEqual(errors, [])
        self.assertEqual(len(results), len(readers))
        self.assertIsNone(runtime.lifecycle_marker_job)
        self.assertNotIn(started["job_id"], service._workers)

    def test_start_persists_recoverable_job_before_lifecycle_marker(self) -> None:
        runtime = FakeRuntime()
        service = self.service(runtime)
        original_begin = runtime.begin_lifecycle
        observed: list[dict | None] = []

        def begin_after_observing(job_id: str) -> None:
            observed.append(service.store.load_job(job_id))
            original_begin(job_id)

        runtime.begin_lifecycle = begin_after_observing  # type: ignore[method-assign]
        _preflight, started = self.preflight_and_start(
            service, "durable-before-marker-0001"
        )
        self.assertEqual(observed[0]["status"], "queued")  # type: ignore[index]
        self.assertEqual(wait_job(service, started["job_id"])["status"], "succeeded")

    def test_preflight_retry_claims_reservation_saved_before_index_crash(self) -> None:
        runtime = FakeRuntime()
        service = self.service(runtime)
        key = "preflight-reservation-crash-0001"
        original_save = service.store.save_idempotency

        def crash_after_reservation(_value: dict[str, str]) -> None:
            raise SystemExit("simulated process loss")

        service.store.save_idempotency = crash_after_reservation  # type: ignore[method-assign]
        with self.assertRaises(SystemExit):
            service.preflight(
                {"release": release_dict(), "idempotency_key": key}
            )
        service.store.save_idempotency = original_save  # type: ignore[method-assign]
        reservations = service.store.list_preflights()
        self.assertEqual(len(reservations), 1)
        token = reservations[0]["token"]

        recovered = service.preflight(
            {"release": release_dict(), "idempotency_key": key}
        )
        self.assertEqual(recovered["preflight_token"], token)
        self.assertEqual(
            service.store.idempotency()[f"preflight:{key}"], token
        )
        self.assertEqual(runtime.calls.count("verify_plan_signature"), 1)

    def test_restart_repairs_and_completes_orphaned_preflight_reservation(self) -> None:
        runtime = FakeRuntime()
        service = self.service(runtime)
        key = "preflight-restart-repair-0001"
        original_save = service.store.save_idempotency

        def crash_after_reservation(_value: dict[str, str]) -> None:
            raise SystemExit("simulated process loss")

        service.store.save_idempotency = crash_after_reservation  # type: ignore[method-assign]
        with self.assertRaises(SystemExit):
            service.preflight(
                {"release": release_dict(), "idempotency_key": key}
            )
        service.store.save_idempotency = original_save  # type: ignore[method-assign]
        token = service.store.list_preflights()[0]["token"]

        restarted = UpdaterTestService(service.store, runtime)
        restarted.resume()
        recovered = restarted.preflight(
            {"release": release_dict(), "idempotency_key": key}
        )

        self.assertEqual(recovered["preflight_token"], token)
        self.assertEqual(
            service.store.idempotency()[f"preflight:{key}"], token
        )
        self.assertEqual(runtime.calls.count("verify_plan_signature"), 1)

    def test_same_process_retry_never_rebinds_an_expired_pending_preflight(self) -> None:
        runtime = FakeRuntime()
        service = self.service(runtime)
        key = "preflight-pending-same-owner-0001"
        token = "pending-token"
        reservation = {
            "token": token,
            "expires_at": "2026-08-02T00:00:00Z",
            "release": release_dict(),
            "idempotency_key": key,
            "owner_id": service._instance_id,
            "state": "pending",
        }
        service.store.save_preflight(token, reservation)
        service.store.save_idempotency({f"preflight:{key}": token})

        with (
            mock.patch(
                "agentic_soc_updater.service.time.monotonic",
                side_effect=(0.0, 301.0),
            ),
            mock.patch("agentic_soc_updater.service.time.sleep"),
            self.assertRaisesRegex(ServiceError, "identical preflight"),
        ):
            service.preflight(
                {"release": release_dict(), "idempotency_key": key}
            )

        reservations = service.store.list_preflights()
        self.assertEqual(len(reservations), 1)
        self.assertEqual(reservations[0]["token"], token)
        self.assertEqual(service.store.idempotency()[f"preflight:{key}"], token)
        self.assertNotIn("verify_plan_signature", runtime.calls)

    def test_start_retry_repairs_job_saved_before_index_crash(self) -> None:
        runtime = FakeRuntime()
        service = self.service(runtime)
        preflight = service.preflight(
            {
                "release": release_dict(),
                "idempotency_key": "preflight-start-crash-0001",
            }
        )
        key = "start-reservation-crash-0001"
        original_save = service.store.save_idempotency

        def crash_after_job(_value: dict[str, str]) -> None:
            raise SystemExit("simulated process loss")

        service.store.save_idempotency = crash_after_job  # type: ignore[method-assign]
        with self.assertRaises(SystemExit):
            service.start(
                {
                    "release": release_dict(),
                    "preflight_token": preflight["preflight_token"],
                    "idempotency_key": key,
                }
            )
        service.store.save_idempotency = original_save  # type: ignore[method-assign]
        jobs = [
            item
            for item in service.store.list_jobs()
            if item.get("start_idempotency_key") == key
        ]
        self.assertEqual(len(jobs), 1)
        self.assertIsNone(runtime.lifecycle_marker_job)

        recovered = service.start(
            {
                "release": release_dict(),
                "preflight_token": preflight["preflight_token"],
                "idempotency_key": key,
            }
        )
        self.assertEqual(recovered["job_id"], jobs[0]["job_id"])
        self.assertEqual(wait_job(service, recovered["job_id"])["status"], "succeeded")
        self.assertEqual(service.store.idempotency()[f"job:{key}"], recovered["job_id"])

        keys = service.store.idempotency()
        keys.pop(f"job:{key}")
        service.store.save_idempotency(keys)
        other = release_dict()
        other.update(
            {
                "release_id": "v0.1.4",
                "version": "0.1.4",
                "tag": "v0.1.4",
                "commit_sha": "3" * 40,
            }
        )
        other["plan_url"], other["bundle_url"] = canonical_asset_urls(
            REPOSITORY, "0.1.4"
        )
        other_preflight = service.preflight(
            {
                "release": other,
                "idempotency_key": "preflight-other-start-0001",
            }
        )
        with self.assertRaisesRegex(ServiceError, "different request"):
            service.start(
                {
                    "release": other,
                    "preflight_token": other_preflight["preflight_token"],
                    "idempotency_key": key,
                }
            )

    def test_restart_repairs_start_index_and_runs_job_saved_before_marker(self) -> None:
        runtime = FakeRuntime()
        service = self.service(runtime)
        preflight = service.preflight(
            {
                "release": release_dict(),
                "idempotency_key": "preflight-start-restart-0001",
            }
        )
        key = "start-restart-repair-0001"
        original_save = service.store.save_idempotency

        def crash_after_job(_value: dict[str, str]) -> None:
            raise SystemExit("simulated process loss")

        service.store.save_idempotency = crash_after_job  # type: ignore[method-assign]
        with self.assertRaises(SystemExit):
            service.start(
                {
                    "release": release_dict(),
                    "preflight_token": preflight["preflight_token"],
                    "idempotency_key": key,
                }
            )
        service.store.save_idempotency = original_save  # type: ignore[method-assign]
        job = next(
            item
            for item in service.store.list_jobs()
            if item.get("start_idempotency_key") == key
        )

        restarted = UpdaterTestService(service.store, runtime)
        restarted.resume()
        terminal = wait_job(restarted, job["job_id"])

        self.assertEqual(terminal["status"], "succeeded")
        self.assertEqual(
            service.store.idempotency()[f"job:{key}"], job["job_id"]
        )

    def test_cancel_retry_repairs_intent_saved_before_index_crash(self) -> None:
        pull_gate = threading.Event()
        runtime = FakeRuntime(pull_gate=pull_gate)
        service = self.service(runtime)
        _preflight, started = self.preflight_and_start(
            service, "cancel-index-crash-0001"
        )
        self.assertTrue(runtime.pull_started.wait(timeout=4))
        key = "cancel-intent-crash-0001"
        original_save = service.store.save_idempotency

        def crash_after_intent(_value: dict[str, str]) -> None:
            raise SystemExit("simulated process loss")

        service.store.save_idempotency = crash_after_intent  # type: ignore[method-assign]
        with self.assertRaises(SystemExit):
            service.cancel(started["job_id"], {"idempotency_key": key})
        service.store.save_idempotency = original_save  # type: ignore[method-assign]
        saved = service.store.load_job(started["job_id"])
        self.assertTrue(saved["cancel_requested"])
        self.assertEqual(
            saved["operation_idempotency"][key],
            f"cancel:{started['job_id']}",
        )

        recovered = service.cancel(
            started["job_id"], {"idempotency_key": key}
        )
        self.assertTrue(recovered["message"].startswith("Cancellation"))
        self.assertEqual(
            service.store.idempotency()[f"operation:{key}"],
            f"cancel:{started['job_id']}",
        )
        pull_gate.set()
        self.assertEqual(wait_job(service, started["job_id"])["status"], "cancelled")

    def test_rollback_retry_repairs_intent_saved_before_index_crash(self) -> None:
        runtime = FakeRuntime()
        service = self.service(runtime)
        _preflight, started = self.preflight_and_start(
            service, "rollback-index-crash-0001"
        )
        self.assertEqual(wait_job(service, started["job_id"])["status"], "succeeded")
        key = "rollback-intent-crash-0001"
        original_save = service.store.save_idempotency

        def crash_after_intent(_value: dict[str, str]) -> None:
            raise SystemExit("simulated process loss")

        service.store.save_idempotency = crash_after_intent  # type: ignore[method-assign]
        with self.assertRaises(SystemExit):
            service.request_rollback(
                started["job_id"], {"idempotency_key": key}
            )
        service.store.save_idempotency = original_save  # type: ignore[method-assign]
        saved = service.store.load_job(started["job_id"])
        self.assertEqual(saved["status"], "rolling_back")
        self.assertEqual(
            saved["operation_idempotency"][key],
            f"rollback:{started['job_id']}",
        )

        recovered = service.request_rollback(
            started["job_id"], {"idempotency_key": key}
        )
        self.assertEqual(recovered["job_id"], started["job_id"])
        self.assertEqual(
            wait_job(service, started["job_id"], {"rolled_back", "failed"})[
                "status"
            ],
            "rolled_back",
        )
        self.assertEqual(
            service.store.idempotency()[f"operation:{key}"],
            f"rollback:{started['job_id']}",
        )

    def test_cancel_after_handoff_restores_old_images_before_any_writer_stop(self) -> None:
        runtime = FakeRuntime(handoff=True)
        service = self.service(runtime)
        _preflight, started = self.preflight_and_start(service)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            job = service.store.load_job(started["job_id"])
            if job and job.get("handoff_attempts") == 1:
                break
            time.sleep(0.01)
        else:
            self.fail("job did not persist the handoff checkpoint")
        service.cancel(
            started["job_id"], {"idempotency_key": "cancel-post-handoff-0001"}
        )
        runtime.handoff = False
        resumed = UpdaterTestService(service.store, runtime)
        resumed.resume()
        terminal = wait_job(resumed, started["job_id"])
        self.assertEqual(terminal["status"], "cancelled")
        self.assertIn("rollback:False", runtime.calls)
        self.assertNotIn("quiesce", runtime.calls)

    def test_override_write_failure_rolls_back_from_durable_snapshot(self) -> None:
        runtime = FakeRuntime(fail_override=True)
        service = self.service(runtime)
        _preflight, started = self.preflight_and_start(service)
        terminal = wait_job(service, started["job_id"])
        self.assertEqual(terminal["status"], "rolled_back")
        self.assertTrue(terminal["override_started"])
        self.assertIn("rollback:False", runtime.calls)
        self.assertNotIn("quiesce", runtime.calls)

    def test_operation_idempotency_is_bound_to_operation_and_job(self) -> None:
        runtime = FakeRuntime()
        service = self.service(runtime)
        _preflight, started = self.preflight_and_start(service)
        terminal = wait_job(service, started["job_id"])
        key = "rollback-key-0001"
        first = service.request_rollback(started["job_id"], {"idempotency_key": key})
        second = service.request_rollback(started["job_id"], {"idempotency_key": key})
        self.assertEqual(first["job_id"], second["job_id"])
        with self.assertRaises(Exception):
            service.cancel(started["job_id"], {"idempotency_key": key})
        wait_job(service, started["job_id"], {"rolled_back", "failed"})

    def test_preflight_idempotency_rejects_rebinding_to_another_release(self) -> None:
        runtime = FakeRuntime()
        service = self.service(runtime)
        key = "preflight-bound-release-0001"
        service.preflight({"release": release_dict(), "idempotency_key": key})
        other = release_dict()
        other.update(
            {
                "release_id": "v0.1.4",
                "version": "0.1.4",
                "tag": "v0.1.4",
                "commit_sha": "3" * 40,
            }
        )
        other["plan_url"], other["bundle_url"] = canonical_asset_urls(
            REPOSITORY, "0.1.4"
        )
        with self.assertRaisesRegex(Exception, "different preflight release"):
            service.preflight({"release": other, "idempotency_key": key})

    def test_concurrent_identical_preflights_share_one_reserved_result(self) -> None:
        gate = threading.Event()
        runtime = FakeRuntime(preflight_gate=gate)
        service = self.service(runtime)
        key = "preflight-concurrent-same-0001"
        responses: list[dict] = []
        failures: list[BaseException] = []

        def run() -> None:
            try:
                responses.append(
                    service.preflight(
                        {"release": release_dict(), "idempotency_key": key}
                    )
                )
            except BaseException as exc:  # pragma: no cover - surfaced below
                failures.append(exc)

        first = threading.Thread(target=run)
        second = threading.Thread(target=run)
        first.start()
        self.assertTrue(runtime.preflight_started.wait(timeout=4))
        second.start()
        gate.set()
        first.join(timeout=5)
        second.join(timeout=5)
        self.assertFalse(failures)
        self.assertEqual(len(responses), 2)
        self.assertEqual(
            responses[0]["preflight_token"], responses[1]["preflight_token"]
        )
        self.assertEqual(runtime.calls.count("verify_plan_signature"), 1)

    def test_concurrent_preflight_cannot_rebind_reserved_key(self) -> None:
        gate = threading.Event()
        runtime = FakeRuntime(preflight_gate=gate)
        service = self.service(runtime)
        key = "preflight-concurrent-different-0001"
        failure: list[BaseException] = []

        def run_first() -> None:
            try:
                service.preflight(
                    {"release": release_dict(), "idempotency_key": key}
                )
            except BaseException as exc:  # pragma: no cover - surfaced below
                failure.append(exc)

        first = threading.Thread(target=run_first)
        first.start()
        self.assertTrue(runtime.preflight_started.wait(timeout=4))
        other = release_dict()
        other.update(
            {
                "release_id": "v0.1.4",
                "version": "0.1.4",
                "tag": "v0.1.4",
                "commit_sha": "3" * 40,
            }
        )
        other["plan_url"], other["bundle_url"] = canonical_asset_urls(
            REPOSITORY, "0.1.4"
        )
        with self.assertRaisesRegex(ServiceError, "different preflight release"):
            service.preflight({"release": other, "idempotency_key": key})
        gate.set()
        first.join(timeout=5)
        self.assertFalse(failure)

    def test_rejected_post_switch_cancel_does_not_consume_idempotency_key(self) -> None:
        runtime = FakeRuntime()
        service = self.service(runtime)
        _preflight, started = self.preflight_and_start(service)
        wait_job(service, started["job_id"])
        key = "rejected-cancel-0001"
        with self.assertRaisesRegex(Exception, "cannot be cancelled"):
            service.cancel(started["job_id"], {"idempotency_key": key})
        self.assertNotIn(f"operation:{key}", service.store.idempotency())

    def test_operator_rollback_never_discards_post_update_database_writes(self) -> None:
        runtime = FakeRuntime()
        service = self.service(runtime)
        _preflight, started = self.preflight_and_start(service)
        wait_job(service, started["job_id"])
        service.request_rollback(
            started["job_id"], {"idempotency_key": "manual-rollback-no-db-0001"}
        )
        terminal = wait_job(service, started["job_id"], {"rolled_back", "failed"})
        self.assertEqual(terminal["status"], "rolled_back")
        self.assertIn("rollback:False", runtime.calls)
        self.assertEqual(terminal["receipt"]["status"], "succeeded")
        self.assertEqual(terminal["rollback_receipt"]["status"], "rolled_back")
        self.assertTrue(terminal["rollback_receipt"]["rollback_performed"])
        self.assertEqual(terminal["rollback_receipt"]["before"]["version"], "0.1.3")
        self.assertEqual(
            terminal["rollback_receipt"]["before"]["commit_sha"], TARGET_SHA
        )
        self.assertEqual(terminal["rollback_receipt"]["after"]["version"], "0.1.2")
        self.assertEqual(
            terminal["rollback_receipt"]["after"]["commit_sha"], CURRENT_SHA
        )
        self.assertEqual(service.receipt(started["job_id"])["status"], "rolled_back")
        self.assertTrue(
            service.receipt(started["job_id"])["rollback_performed"]
        )
        self.assertIn("PostgreSQL is preserved", terminal["message"])

    def test_operator_rollback_rejects_while_another_update_is_active(self) -> None:
        runtime = FakeRuntime()
        service = self.service(runtime)
        _preflight, first = self.preflight_and_start(service, "first-0001")
        wait_job(service, first["job_id"])
        gate = threading.Event()
        runtime.backup_gate = gate
        runtime.backup_started.clear()
        _preflight, second = self.preflight_and_start(service, "second-0001")
        self.assertTrue(runtime.backup_started.wait(timeout=4))
        with self.assertRaisesRegex(ServiceError, "another update or rollback"):
            service.request_rollback(
                first["job_id"],
                {"idempotency_key": "rollback-active-other-0001"},
            )
        gate.set()
        wait_job(service, second["job_id"])

    def test_operator_rollback_rejects_superseded_successful_job(self) -> None:
        runtime = FakeRuntime()
        service = self.service(runtime)
        _preflight, first = self.preflight_and_start(service, "first-0002")
        wait_job(service, first["job_id"])
        time.sleep(0.002)
        _preflight, second = self.preflight_and_start(service, "second-0002")
        wait_job(service, second["job_id"])
        with self.assertRaisesRegex(ServiceError, "superseded"):
            service.request_rollback(
                first["job_id"],
                {"idempotency_key": "rollback-stale-job-0001"},
            )

    def test_operator_rollback_rechecks_exact_installed_target(self) -> None:
        runtime = FakeRuntime()
        service = self.service(runtime)
        _preflight, started = self.preflight_and_start(service, "identity-0001")
        wait_job(service, started["job_id"])
        runtime.current_identity["backend_image_id"] = f"sha256:{'9' * 64}"
        with self.assertRaisesRegex(ServiceError, "no longer matches"):
            service.request_rollback(
                started["job_id"],
                {"idempotency_key": "rollback-identity-drift-0001"},
            )

    def test_operator_rollback_failure_is_not_reported_as_automatic(self) -> None:
        runtime = FakeRuntime()
        service = self.service(runtime)
        _preflight, started = self.preflight_and_start(service, "failure-0001")
        wait_job(service, started["job_id"])
        runtime.fail_rollback = True
        service.request_rollback(
            started["job_id"],
            {"idempotency_key": "rollback-forced-failure-0001"},
        )
        terminal = wait_job(service, started["job_id"], {"failed"})
        self.assertFalse(terminal["rollback"]["automatic"])
        self.assertIn("Operator-requested rollback failed", terminal["message"])


class TerminalReplayTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.service = UpdaterTestService(
            JsonStore(Path(self.temp.name) / "state"), FakeRuntime()
        )

    def _save_job(self, number: int, status: str) -> None:
        self.service.store.save_job(
            {
                "job_id": f"update-{number:03d}",
                "release_id": "v0.1.3",
                "status": status,
                "stage": "completed" if status in TERMINAL_STATUSES else "observing",
                "progress": 100 if status in TERMINAL_STATUSES else 92,
                "message": "Synthetic terminal job",
                "started_at": f"2026-08-03T00:{number:02d}:00Z",
                "updated_at": f"2026-08-03T00:{number:02d}:30Z",
                "private_backup_path": "/srv/agentic-soc/secret.dump",
                "private_image_digest": f"sha256:{'f' * 64}",
            }
        )

    def test_terminal_page_is_bounded_filtered_and_public(self) -> None:
        for number in range(MAX_TERMINAL_JOBS + 2):
            self._save_job(number, "succeeded")
        self._save_job(MAX_TERMINAL_JOBS + 2, "running")

        page = terminal_page(self.service, MAX_TERMINAL_JOBS)

        self.assertEqual(len(page["jobs"]), MAX_TERMINAL_JOBS)
        self.assertTrue(
            all(job["status"] in TERMINAL_STATUSES for job in page["jobs"])
        )
        self.assertTrue(
            all("private_backup_path" not in job for job in page["jobs"])
        )
        self.assertTrue(
            all("private_image_digest" not in job for job in page["jobs"])
        )

    def test_terminal_query_accepts_only_one_bounded_integer(self) -> None:
        self.assertEqual(_terminal_limit("/v1/terminals"), MAX_TERMINAL_JOBS)
        self.assertEqual(_terminal_limit("/v1/terminals?limit=7"), 7)
        for path in (
            "/v1/terminals?limit=0",
            "/v1/terminals?limit=65",
            "/v1/terminals?limit=abc",
            "/v1/terminals?limit=1&limit=2",
            "/v1/terminals?unexpected=1",
        ):
            with self.subTest(path=path), self.assertRaises(ServiceError):
                _terminal_limit(path)


class UnixSocketWireTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.socket_path = Path(self.temp.name) / "control.sock"
        self.runtime = FakeRuntime()
        self.service = UpdaterTestService(JsonStore(Path(self.temp.name) / "state"), self.runtime)
        self.server = UnixHTTPServer(str(self.socket_path), Handler)
        self.server.service = self.service  # type: ignore[attr-defined]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self._stop_server)

    def _stop_server(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def test_backend_client_parses_real_uds_status_preflight_job_and_receipt(self) -> None:
        from app.engine.update_supervisor import UpdateSupervisorClient

        async def exercise() -> None:
            client = UpdateSupervisorClient(str(self.socket_path))
            status = await client.status()
            self.assertTrue(status.available)
            preflight = await client.preflight(
                {"release": release_dict(), "idempotency_key": "uds-preflight-0001"}
            )
            started = await client.start(
                {
                    "release": release_dict(),
                    "preflight_token": preflight.preflight_token,
                    "idempotency_key": "uds-start-000000001",
                }
            )
            deadline = time.monotonic() + 5
            current = started
            while current.status not in TERMINAL_STATUSES and time.monotonic() < deadline:
                await asyncio.sleep(0.01)
                current = await client.job(started.job_id)
            self.assertEqual(current.status, "succeeded")
            receipt = await client.receipt(started.job_id)
            self.assertEqual(receipt.after.version, "0.1.3")
            terminal = await client.terminals(limit=2)
            self.assertEqual([job.job_id for job in terminal.jobs], [started.job_id])
            self.assertEqual(terminal.jobs[0].status, "succeeded")

        asyncio.run(exercise())


class ControlSocketPermissionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.socket_path = Path(self.temp.name) / "control.sock"
        self.socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.socket.bind(str(self.socket_path))
        self.addCleanup(self.socket.close)

    @staticmethod
    def _details_with(
        details: os.stat_result,
        *,
        mode: int | None = None,
        uid: int | None = None,
        gid: int | None = None,
    ) -> os.stat_result:
        values = list(details)
        values[0] = details.st_mode if mode is None else mode
        values[4] = details.st_uid if uid is None else uid
        values[5] = details.st_gid if gid is None else gid
        return os.stat_result(values)

    def test_socket_uses_inherited_backend_group_without_chown(self) -> None:
        actual = self.socket_path.lstat()
        expected_gid = actual.st_gid
        root_owned = self._details_with(actual, uid=0)

        with (
            mock.patch.object(Path, "lstat", return_value=root_owned),
            mock.patch(
                "agentic_soc_updater.server.os.chown",
                side_effect=AssertionError("CAP_CHOWN must not be required"),
            ),
        ):
            _secure_control_socket(self.socket_path, expected_gid)

        details = self.socket_path.stat()
        self.assertEqual(details.st_gid, expected_gid)
        self.assertEqual(stat.S_IMODE(details.st_mode), 0o660)

    def test_socket_group_mismatch_fails_closed_before_publication(self) -> None:
        actual = self.socket_path.lstat()
        root_owned = self._details_with(actual, uid=0)

        with (
            mock.patch.object(Path, "lstat", return_value=root_owned),
            mock.patch("agentic_soc_updater.server.os.chmod") as chmod,
            self.assertRaisesRegex(PermissionError, "primary group"),
        ):
            _secure_control_socket(self.socket_path, actual.st_gid + 1)
        chmod.assert_not_called()

    def test_non_root_socket_owner_fails_closed_before_chmod(self) -> None:
        actual = self.socket_path.lstat()
        non_root = self._details_with(actual, uid=10001)

        with (
            mock.patch.object(Path, "lstat", return_value=non_root),
            mock.patch("agentic_soc_updater.server.os.chmod") as chmod,
            self.assertRaisesRegex(PermissionError, "owned by root"),
        ):
            _secure_control_socket(self.socket_path, actual.st_gid)
        chmod.assert_not_called()

    def test_non_socket_path_fails_closed_before_chmod(self) -> None:
        regular_path = Path(self.temp.name) / "not-a-socket"
        regular_path.write_text("not a socket", encoding="utf-8")
        actual = regular_path.lstat()
        root_owned = self._details_with(actual, uid=0)

        with (
            mock.patch.object(Path, "lstat", return_value=root_owned),
            mock.patch("agentic_soc_updater.server.os.chmod") as chmod,
            self.assertRaisesRegex(PermissionError, "not a Unix socket"),
        ):
            _secure_control_socket(regular_path, actual.st_gid)
        chmod.assert_not_called()


class UpdaterImageContractTests(unittest.TestCase):
    def test_shipping_image_sets_backend_gid_without_adding_cap_chown(self) -> None:
        dockerfile = (ROOT / "updater" / "Dockerfile").read_text(encoding="utf-8")
        compose = (ROOT / "deploy" / "docker-compose.agnostic.yml").read_text(
            encoding="utf-8"
        )

        self.assertIn("USER 0:10001", dockerfile)
        self.assertIn('cap_drop: ["ALL"]', compose)
        self.assertIn("UPDATE_CONTROL_GID=10001", compose)

    def test_shipping_image_places_sigstore_cache_on_durable_writable_state(self) -> None:
        dockerfile = (ROOT / "updater" / "Dockerfile").read_text(encoding="utf-8")

        self.assertIn(
            "TUF_ROOT=/var/lib/agentic-soc-updater/sigstore-root",
            dockerfile,
        )
        self.assertNotIn("TUF_ROOT=/root/", dockerfile)


if __name__ == "__main__":
    unittest.main()
