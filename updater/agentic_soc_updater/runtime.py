"""Fixed host operations for the supported Docker Compose/PostgreSQL profile."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import threading
import time
from typing import Any
import urllib.error
import urllib.request

from .contract import UpgradePlan, compatible, download_host_allowed, parse_semver


class RuntimeFailure(RuntimeError):
    pass


class SafeRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request: urllib.request.Request, fp: Any, code: int, msg: str, headers: Any, newurl: str) -> urllib.request.Request:
        if not download_host_allowed(newurl):
            raise RuntimeFailure("release asset redirected to an untrusted host")
        return super().redirect_request(request, fp, code, msg, headers, newurl)


class CommandRunner:
    """No shell, bounded output, and explicit timeouts for every host operation."""

    def run(
        self,
        command: list[str],
        *,
        timeout: int = 300,
        input_data: bytes | None = None,
        stdin_file: Any | None = None,
        stdout_file: Any | None = None,
    ) -> subprocess.CompletedProcess[bytes]:
        if not command or not all(isinstance(part, str) and part for part in command):
            raise RuntimeFailure("invalid fixed command")
        if input_data is not None and stdin_file is not None:
            raise RuntimeFailure("host operation cannot use two input sources")
        result = subprocess.run(
            command,
            input=input_data,
            stdin=stdin_file if input_data is None else None,
            stdout=stdout_file if stdout_file is not None else subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
            check=False,
        )
        if result.returncode:
            summary = result.stderr.decode("utf-8", "replace")[-1200:].replace("\n", " ")
            raise RuntimeFailure(f"host operation failed ({command[0]}): {summary}")
        return result


@dataclass(frozen=True)
class RuntimeConfig:
    trusted_repository: str
    compose_file: Path
    env_file: Path
    state_dir: Path
    backup_dir: Path
    host_override_file: Path | None = None
    project_name: str = "tlsoc-agentic-soc"
    backend_service: str = "tlsoc-backend"
    webui_service: str = "tlsoc-webui"
    updater_service: str = "agentic-soc-updater"
    postgres_container: str = "tlsoc-postgres"
    backend_container: str = "tlsoc-backend"
    webui_container: str = "tlsoc-webui"


class ComposeRuntime:
    def __init__(self, config: RuntimeConfig, runner: CommandRunner | None = None) -> None:
        self.config = config
        self.runner = runner or CommandRunner()
        self.override_file = config.state_dir / "active-release.compose.yml"
        self.pending_override_file = config.state_dir / "pending-release.compose.yml"
        self.config.state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.config.backup_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        if self.config.host_override_file is not None:
            self.config.host_override_file.parent.mkdir(
                parents=True, exist_ok=True, mode=0o700
            )
        lifecycle_root = (
            self.config.host_override_file.parent
            if self.config.host_override_file is not None
            else self.config.state_dir
        )
        self.lifecycle_lock_file = lifecycle_root / "lifecycle.lock"
        self.lifecycle_marker_file = lifecycle_root / "update-active.json"
        self._lifecycle_guard = threading.Lock()
        self._lifecycle_fd: int | None = None
        self._lifecycle_job_id: str | None = None

    def _compose(self, *args: str, timeout: int = 600) -> subprocess.CompletedProcess[bytes]:
        command = [
            "docker", "compose",
            "--project-name", self.config.project_name,
            "--env-file", str(self.config.env_file),
            "--file", str(self.config.compose_file),
        ]
        if self.override_file.exists():
            command.extend(["--file", str(self.override_file)])
        command.extend(args)
        return self.runner.run(command, timeout=timeout)

    def _docker_json(self, *args: str) -> Any:
        result = self.runner.run(["docker", *args], timeout=60)
        try:
            return json.loads(result.stdout.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise RuntimeFailure("Docker returned malformed inspection data") from exc

    def _container(self, name: str) -> dict[str, Any]:
        value = self._docker_json("inspect", name)
        if not isinstance(value, list) or len(value) != 1 or not isinstance(value[0], dict):
            raise RuntimeFailure(f"required container {name} is not uniquely inspectable")
        return value[0]

    def _labels(self, container: dict[str, Any]) -> dict[str, str]:
        labels = container.get("Config", {}).get("Labels", {})
        return labels if isinstance(labels, dict) else {}

    def installed_identity(self) -> dict[str, str]:
        backend = self._container(self.config.backend_container)
        webui = self._container(self.config.webui_container)
        backend_labels = self._labels(backend)
        webui_labels = self._labels(webui)
        backend_state_schema = backend_labels.get(
            "io.agentic-soc.state.schema", "unknown"
        )
        webui_state_schema = webui_labels.get(
            "io.agentic-soc.state.schema", "unknown"
        )
        fields = {
            "version": backend_labels.get("org.opencontainers.image.version", "unknown"),
            "channel": backend_labels.get("dev.tlsoc.release.channel", "unknown"),
            "commit_sha": backend_labels.get("org.opencontainers.image.revision", "unknown"),
            "state_schema": backend_state_schema,
            "backend_image_id": str(backend.get("Image", "")),
            "webui_image_id": str(webui.get("Image", "")),
        }
        if (
            webui_labels.get("org.opencontainers.image.version") != fields["version"]
            or webui_labels.get("org.opencontainers.image.revision") != fields["commit_sha"]
            or webui_labels.get("dev.tlsoc.release.channel") != fields["channel"]
            or webui_state_schema != fields["state_schema"]
        ):
            raise RuntimeFailure("installed backend and Web release identities disagree")
        if not re.fullmatch(r"sha256:[0-9a-f]{64}", fields["backend_image_id"]):
            raise RuntimeFailure("installed backend has no immutable image ID")
        if not re.fullmatch(r"sha256:[0-9a-f]{64}", fields["webui_image_id"]):
            raise RuntimeFailure("installed Web Console has no immutable image ID")
        return fields

    def _assert_canonical_container(
        self,
        container: dict[str, Any],
        service: str,
        *,
        postgres_volume: bool = False,
    ) -> None:
        labels = self._labels(container)
        expected_labels = {
            "com.docker.compose.project": self.config.project_name,
            "com.docker.compose.service": service,
            "com.docker.compose.container-number": "1",
        }
        if any(labels.get(key) != value for key, value in expected_labels.items()):
            raise RuntimeFailure(f"{service} is outside the canonical single-replica Compose project")
        networks = container.get("NetworkSettings", {}).get("Networks", {})
        if not isinstance(networks, dict) or set(networks) != {
            f"{self.config.project_name}_default"
        }:
            raise RuntimeFailure(f"{service} is outside the canonical Compose network")
        if postgres_volume:
            mounts = container.get("Mounts", [])
            matches = [
                item
                for item in mounts
                if isinstance(item, dict)
                and item.get("Destination") == "/var/lib/postgresql/data"
            ]
            if len(matches) != 1 or matches[0].get("Type") != "volume" or matches[0].get("Name") != f"{self.config.project_name}_tlsoc-pgdata":
                raise RuntimeFailure("PostgreSQL is not using the canonical owned-state volume")

    @staticmethod
    def _parse_env(path: Path) -> dict[str, str]:
        values: dict[str, str] = {}
        for raw in path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip().strip('"').strip("'")
        return values

    def _signature_identity(self, plan: UpgradePlan) -> str:
        return f"https://github.com/{self.config.trusted_repository}/.github/workflows/release.yml@refs/tags/{plan.tag}"

    def verify_plan_signature(self, plan_path: Path, bundle_path: Path, tag: str) -> None:
        identity = f"https://github.com/{self.config.trusted_repository}/.github/workflows/release.yml@refs/tags/{tag}"
        self.runner.run(
            [
                "cosign", "verify-blob",
                "--bundle", str(bundle_path),
                "--certificate-identity", identity,
                "--certificate-oidc-issuer", "https://token.actions.githubusercontent.com",
                str(plan_path),
            ],
            timeout=180,
        )

    def verify_image_signatures(self, plan: UpgradePlan) -> None:
        identity = self._signature_identity(plan)
        for component in plan.components.values():
            self.runner.run(
                [
                    "cosign", "verify",
                    "--certificate-identity", identity,
                    "--certificate-oidc-issuer", "https://token.actions.githubusercontent.com",
                    component.image,
                ],
                timeout=240,
            )

    def preflight(self, plan: UpgradePlan) -> dict[str, Any]:
        checks: list[dict[str, Any]] = []
        blockers: list[dict[str, str]] = []
        warnings: list[dict[str, str]] = []

        def check(code: str, ok: bool, detail: str) -> None:
            label = code.replace("_", " ").capitalize()
            checks.append({"code": code, "label": label, "status": "pass" if ok else "fail", "detail": detail})
            if not ok:
                blockers.append({"code": code, "message": detail, "remediation": "Correct this deployment precondition and run preflight again."})

        check("compose_file", self.config.compose_file.is_file(), "Reference Compose file is readable")
        check("environment_file", self.config.env_file.is_file(), "Deployment environment file is readable")
        if blockers:
            return {"checks": checks, "blockers": blockers, "warnings": warnings, "current": {}}
        compose_sha256 = hashlib.sha256(self.config.compose_file.read_bytes()).hexdigest()
        check(
            "canonical_compose",
            compose_sha256 == plan.compose_sha256,
            (
                "Mounted Compose definition matches the signed canonical release file"
                if compose_sha256 == plan.compose_sha256
                else "Mounted Compose definition differs from the signed canonical release file"
            ),
        )

        try:
            self.runner.run(["docker", "version", "--format", "{{.Server.Version}}"], timeout=30)
            self.runner.run(["docker", "compose", "version"], timeout=30)
            check("docker", True, "Docker Engine and Compose are available")
        except RuntimeFailure as exc:
            check("docker", False, str(exc))
            return {"checks": checks, "blockers": blockers, "warnings": warnings, "current": {}}

        env = self._parse_env(self.config.env_file)
        auth_enabled = env.get("TLSOC_AUTH_ENABLED", "false").lower() == "true"
        stable_auth = len(env.get("TLSOC_AUTH_JWT_SECRET", "")) >= 32
        check("stable_auth", auth_enabled and stable_auth, "Authentication must be enabled with a durable 32+ character JWT secret")
        check("postgres_password", bool(env.get("TLSOC_PG_PASSWORD")), "PostgreSQL password is durably present in the deployment environment")

        try:
            backend = self._container(self.config.backend_container)
            webui = self._container(self.config.webui_container)
            postgres = self._container(self.config.postgres_container)
            updater = self._container(self.config.updater_service)
            self._assert_canonical_container(backend, self.config.backend_service)
            self._assert_canonical_container(webui, self.config.webui_service)
            self._assert_canonical_container(
                postgres, "tlsoc-postgres", postgres_volume=True
            )
            self._assert_canonical_container(updater, self.config.updater_service)
            check("canonical_topology", True, "Canonical single-replica Compose topology is active")
            backend_env = backend.get("Config", {}).get("Env", [])
            check("state_backend", "STATE_BACKEND=postgres" in backend_env, "Owned state is PostgreSQL")
            check("postgres_health", postgres.get("State", {}).get("Health", {}).get("Status") == "healthy", "PostgreSQL is healthy")
            check("updater_socket", updater.get("State", {}).get("Running") is True, "Dedicated updater supervisor is running")
            current = self.installed_identity()
            check("installed_identity", current["version"] != "unknown", "Installed backend and Web have a coherent version")
            current_version = current["version"]
            legacy_bootstrap = current_version == "0.1.1"
            managed_stable_identity = (
                current["channel"] == "stable"
                and re.fullmatch(r"[0-9a-f]{40}", current["commit_sha"]) is not None
                and current["state_schema"] == str(plan.state_schema)
            )
            check(
                "managed_stable_identity",
                managed_stable_identity or legacy_bootstrap,
                (
                    "Installed application has a coherent immutable Stable identity"
                    if managed_stable_identity
                    else (
                        "The final pre-supervisor v0.1.1 deployment is eligible only "
                        "through the host-authorized bootstrap"
                        if legacy_bootstrap
                        else "Installed application is not an immutable Stable release"
                    )
                ),
            )
            if legacy_bootstrap and not managed_stable_identity:
                warnings.append(
                    {
                        "code": "legacy_bootstrap_identity",
                        "message": (
                            "The v0.1.1 application predates managed release identity; "
                            "the exact tagged host bootstrap is the installation authority."
                        ),
                        "remediation": (
                            "Complete this one-time host-authorized transition; later "
                            "updates require an immutable Stable identity."
                        ),
                    }
                )
            check("compatibility", compatible(current_version, plan), f"Installed {current_version} is in the signed compatibility range")
            check(
                "state_schema",
                current.get("state_schema") == str(plan.state_schema) or legacy_bootstrap,
                (
                    f"Installed state schema {plan.state_schema} matches the signed target"
                    if current.get("state_schema") == str(plan.state_schema)
                    else (
                        "Legacy v0.1.1 state is admitted only through the host bootstrap"
                        if legacy_bootstrap
                        else "Installed release does not prove the supported state schema"
                    )
                ),
            )
            check("upgrade_direction", parse_semver(plan.version) > parse_semver(current_version), f"Target {plan.version} is newer than installed {current_version}")
        except (RuntimeFailure, ValueError) as exc:
            current = {}
            check("deployment_shape", False, str(exc))

        try:
            output = self.runner.run(
                ["docker", "exec", self.config.postgres_container, "du", "-sb", "/var/lib/postgresql/data"],
                timeout=60,
            ).stdout.decode("ascii", "replace")
            estimated = int(output.split()[0])
            free = shutil.disk_usage(self.config.backup_dir).free
            needed = max(estimated * 2, 512 * 1024 * 1024)
            check("backup_space", free >= needed, f"Backup filesystem has {free} bytes free; {needed} required")
        except (RuntimeFailure, ValueError, IndexError) as exc:
            check("backup_space", False, f"Could not establish backup capacity: {exc}")

        warnings.append(
            {
                "code": "runtime_secret_authority",
                "message": "The backend must separately confirm that UI-entered connector and provider secrets are durable before starting.",
                "remediation": "Persist every configured secret in the deployment environment before authorizing the update.",
            }
        )
        return {"checks": checks, "blockers": blockers, "warnings": warnings, "current": current}

    def pull_and_validate(self, plan: UpgradePlan) -> None:
        for component in plan.components.values():
            self.runner.run(["docker", "pull", component.image], timeout=1200)
            inspected = self._docker_json("image", "inspect", component.image)
            if not isinstance(inspected, list) or len(inspected) != 1:
                raise RuntimeFailure(f"could not inspect pulled {component.name} image")
            labels = inspected[0].get("Config", {}).get("Labels", {})
            for key, expected in component.labels.items():
                if labels.get(key) != expected:
                    raise RuntimeFailure(f"pulled {component.name} image label {key} does not match signed plan")

    def capture_snapshot(self, job_id: str) -> dict[str, Any]:
        fingerprint = self.deployment_fingerprint()
        return {
            **fingerprint,
            "captured_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "job_id": job_id,
        }

    def deployment_fingerprint(self) -> dict[str, str]:
        """Return exact mutable-host identity without changing deployment state."""

        identity = self.installed_identity()
        updater_image = str(
            self._container(self.config.updater_service).get("Image", "")
        )
        if not re.fullmatch(r"sha256:[0-9a-f]{64}", updater_image):
            raise RuntimeFailure("installed updater has no immutable image ID")
        return {
            **identity,
            "updater_image_id": updater_image,
            "compose_sha256": hashlib.sha256(
                self.config.compose_file.read_bytes()
            ).hexdigest(),
            "environment_sha256": hashlib.sha256(
                self.config.env_file.read_bytes()
            ).hexdigest(),
        }

    def _target_override_source(self, plan: UpgradePlan) -> str:
        return (
            "# Generated by the Agentic SOC updater. Do not edit.\n"
            "services:\n"
            f"  {self.config.updater_service}:\n    image: {plan.components['updater'].image}\n"
            f"  {self.config.backend_service}:\n    image: {plan.components['backend'].image}\n"
            f"  {self.config.webui_service}:\n    image: {plan.components['webui'].image}\n"
        )

    def prepare_target_override(self, plan: UpgradePlan) -> None:
        """Persist target pins privately without changing any Compose lifecycle input.

        The pending file is available to the updater self-handoff through its
        private state volume.  It is deliberately absent from both ``_compose``
        and the host lifecycle wrapper, so neither can start target application
        images before writer quiescence and the verified PostgreSQL backup.
        """

        self._atomic_write(
            self.pending_override_file,
            self._target_override_source(plan),
            suffix="pending-target",
            mode=0o600,
        )

    def activate_target_override(self, plan: UpgradePlan) -> None:
        """Publish already-verified target pins at the durable switch boundary."""

        expected = self._target_override_source(plan)
        try:
            pending = self.pending_override_file.read_text(encoding="utf-8")
        except OSError as exc:
            raise RuntimeFailure("pending target release override is unavailable") from exc
        if pending != expected:
            raise RuntimeFailure("pending target release override changed before activation")
        # Internal Compose state is committed first.  If the host stops between
        # these two fsync-backed writes, job replay repeats this idempotent method
        # and publishes the same exact host override.  Publishing host-first would
        # let an external lifecycle command get ahead of supervisor recovery.
        self._atomic_write(
            self.override_file, expected, suffix="active-target", mode=0o600
        )
        if self.config.host_override_file is not None:
            self._atomic_write(
                self.config.host_override_file,
                expected,
                suffix="active-target",
                mode=0o644,
            )
        self._remove_pending_override()

    def _write_override(self, source: str, *, suffix: str) -> None:
        """Durably replace the active internal and host Compose overrides."""

        self._atomic_write(self.override_file, source, suffix=suffix, mode=0o600)
        if self.config.host_override_file is not None:
            self._atomic_write(
                self.config.host_override_file, source, suffix=suffix, mode=0o644
            )
        self._remove_pending_override()

    def _remove_pending_override(self) -> None:
        try:
            self.pending_override_file.unlink()
        except FileNotFoundError:
            return
        directory_flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
        directory = os.open(self.pending_override_file.parent, directory_flags)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)

    def begin_lifecycle(self, job_id: str) -> None:
        """Reserve the host lifecycle and publish a durable active-job marker.

        The wrapper takes the same advisory lock before every mutating Compose
        command.  The marker bridges updater self-handoff: the old process may
        release its file descriptor before the replacement acquires it, but the
        wrapper still refuses mutation while the durable job remains active.
        """

        if not re.fullmatch(r"update-[0-9a-f-]{36}", job_id):
            raise RuntimeFailure("invalid update job identity for lifecycle guard")
        with self._lifecycle_guard:
            if self._lifecycle_fd is not None:
                if self._lifecycle_job_id == job_id:
                    return
                raise RuntimeFailure("another updater lifecycle guard is active")
            descriptor = os.open(
                self.lifecycle_lock_file,
                os.O_RDONLY | os.O_CREAT,
                0o644,
            )
            try:
                # The updater waits for an already-running wrapper command to
                # finish, then publishes its marker while still holding the same
                # lock.  The wrapper uses a non-blocking acquisition so a later
                # command is refused immediately for the duration of this job.
                fcntl.flock(descriptor, fcntl.LOCK_EX)
            except OSError:
                os.close(descriptor)
                raise
            try:
                marker = None
                try:
                    marker = json.loads(
                        self.lifecycle_marker_file.read_text(encoding="utf-8")
                    )
                except FileNotFoundError:
                    pass
                except (OSError, json.JSONDecodeError) as exc:
                    raise RuntimeFailure(
                        "the host update lifecycle marker is unreadable"
                    ) from exc
                if marker is not None and (
                    not isinstance(marker, dict) or marker.get("job_id") != job_id
                ):
                    raise RuntimeFailure(
                        "another or unreconciled update lifecycle is active"
                    )
                self._atomic_write(
                    self.lifecycle_marker_file,
                    json.dumps({"job_id": job_id}, sort_keys=True) + "\n",
                    suffix="lifecycle",
                    mode=0o644,
                )
            except Exception:
                fcntl.flock(descriptor, fcntl.LOCK_UN)
                os.close(descriptor)
                raise
            self._lifecycle_fd = descriptor
            self._lifecycle_job_id = job_id

    def reconcile_terminal_lifecycle(self, terminal_job_ids: set[str]) -> bool:
        """Clear only a crash-left marker backed by an exact terminal job.

        A process or host can stop after the terminal job JSON is fsynced but
        before :meth:`release_lifecycle` removes the host marker. On startup,
        take the same advisory lock as the updater and supported wrapper, then
        remove that marker only when its exact job is present in the caller's
        durable terminal-job set. Unknown, malformed, or active-job markers
        remain in place so lifecycle mutation continues to fail closed.
        """

        with self._lifecycle_guard:
            if self._lifecycle_fd is not None:
                return False
            descriptor = os.open(
                self.lifecycle_lock_file,
                os.O_RDONLY | os.O_CREAT,
                0o644,
            )
            try:
                try:
                    fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    return False
                try:
                    marker = json.loads(
                        self.lifecycle_marker_file.read_text(encoding="utf-8")
                    )
                except FileNotFoundError:
                    return False
                except (OSError, json.JSONDecodeError):
                    return False
                if not isinstance(marker, dict):
                    return False
                job_id = marker.get("job_id")
                if (
                    not isinstance(job_id, str)
                    or not re.fullmatch(r"update-[0-9a-f-]{36}", job_id)
                    or job_id not in terminal_job_ids
                ):
                    return False
                self.lifecycle_marker_file.unlink()
                directory_flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
                directory = os.open(
                    self.lifecycle_marker_file.parent, directory_flags
                )
                try:
                    os.fsync(directory)
                finally:
                    os.close(directory)
                return True
            finally:
                fcntl.flock(descriptor, fcntl.LOCK_UN)
                os.close(descriptor)

    def release_lifecycle(self, job_id: str, *, terminal: bool) -> None:
        """Release the process lock; remove the marker only for terminal jobs."""

        with self._lifecycle_guard:
            if self._lifecycle_fd is None:
                return
            if self._lifecycle_job_id != job_id:
                raise RuntimeFailure("lifecycle guard owner changed unexpectedly")
            if terminal:
                try:
                    marker = json.loads(
                        self.lifecycle_marker_file.read_text(encoding="utf-8")
                    )
                except (FileNotFoundError, OSError, json.JSONDecodeError) as exc:
                    raise RuntimeFailure(
                        "cannot safely clear the host update lifecycle marker"
                    ) from exc
                if not isinstance(marker, dict) or marker.get("job_id") != job_id:
                    raise RuntimeFailure(
                        "host update lifecycle marker owner changed unexpectedly"
                    )
                self.lifecycle_marker_file.unlink()
                directory_flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
                directory = os.open(self.lifecycle_marker_file.parent, directory_flags)
                try:
                    os.fsync(directory)
                finally:
                    os.close(directory)
            descriptor = self._lifecycle_fd
            self._lifecycle_fd = None
            self._lifecycle_job_id = None
            fcntl.flock(descriptor, fcntl.LOCK_UN)
            os.close(descriptor)

    @staticmethod
    def _atomic_write(path: Path, source: str, *, suffix: str, mode: int) -> None:
        """Write a generated lifecycle file and fsync both file and directory."""

        temporary = path.with_name(
            f".{path.name}.{os.getpid()}.{suffix}.tmp"
        )
        try:
            with temporary.open("w", encoding="utf-8") as handle:
                os.chmod(temporary, mode)
                handle.write(source)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, path)
            directory_flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
            directory = os.open(path.parent, directory_flags)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            try:
                temporary.unlink()
            except FileNotFoundError:
                pass

    def updater_handoff_required(self, plan: UpgradePlan) -> bool:
        current = self._container(self.config.updater_service)
        target = self._docker_json("image", "inspect", plan.components["updater"].image)
        if not isinstance(target, list) or len(target) != 1:
            raise RuntimeFailure("target updater image is not locally inspectable")
        return str(current.get("Image", "")) != str(target[0].get("Id", ""))

    def handoff_updater(self) -> None:
        current = self._container(self.config.updater_service)
        current_image = str(current.get("Image", ""))
        try:
            target_override = self.pending_override_file.read_text(encoding="utf-8")
        except OSError as exc:
            raise RuntimeFailure("pending target release override is unavailable") from exc
        target_match = re.search(
            rf"^  {re.escape(self.config.updater_service)}:\n    image: ([^\n]+)$",
            target_override,
            re.MULTILINE,
        )
        if not target_match:
            raise RuntimeFailure("target updater image is absent from the verified override")
        target_image = target_match.group(1)
        target = self._docker_json("image", "inspect", target_image)
        if not isinstance(target, list) or len(target) != 1:
            raise RuntimeFailure("target updater image is not locally inspectable")
        target_image_id = str(target[0].get("Id", ""))
        if not re.fullmatch(r"sha256:[0-9a-f]{64}", target_image_id):
            raise RuntimeFailure("target updater image has no immutable local image ID")

        expected_destinations = {
            "/var/run/docker.sock",
            "/deployment/docker-compose.yml",
            "/deployment/.env",
            "/deployment/host-runtime",
            "/run/agentic-soc-updater",
            "/var/lib/agentic-soc-updater",
            "/var/backups/agentic-soc",
        }
        mounts = current.get("Mounts", [])
        by_destination = {
            str(item.get("Destination")): item
            for item in mounts
            if isinstance(item, dict) and item.get("Destination") in expected_destinations
        }
        if set(by_destination) != expected_destinations:
            raise RuntimeFailure("current updater mounts do not match the fixed self-handoff contract")
        networks = current.get("NetworkSettings", {}).get("Networks", {})
        if not isinstance(networks, dict) or len(networks) != 1:
            raise RuntimeFailure("current updater must use exactly one Compose network")
        network = next(iter(networks))
        if network != f"{self.config.project_name}_default":
            raise RuntimeFailure("current updater is outside the supported Compose network")

        next_name = "agentic-soc-updater-next"
        previous_name = "agentic-soc-updater-previous"
        helper_name = "agentic-soc-updater-handoff"
        for stale in (next_name, previous_name, helper_name):
            self.runner.run(["docker", "rm", "--force", stale], timeout=30) if self._container_exists(stale) else None

        create = [
            "docker", "create", "--name", next_name,
            "--restart", "unless-stopped",
            "--read-only",
            "--cap-drop", "ALL",
            "--security-opt", "no-new-privileges:true",
            "--network", network,
            "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=67108864",
        ]
        # Keep the replacement discoverable as the same Compose service. The
        # config hash is deliberately not copied: the next ordinary Compose
        # reconciliation must recreate this raw handoff container from the
        # signed persistent override, not mistake it for fully converged state.
        current_labels = self._labels(current)
        compose_label_keys = {
            "com.docker.compose.project",
            "com.docker.compose.project.config_files",
            "com.docker.compose.project.working_dir",
            "com.docker.compose.service",
            "com.docker.compose.container-number",
            "com.docker.compose.oneoff",
            "com.docker.compose.version",
        }
        for key in sorted(compose_label_keys):
            value = current_labels.get(key)
            if value and not any(character in value for character in "\n\r"):
                create.extend(["--label", f"{key}={value}"])
        create.extend(["--label", f"com.docker.compose.image={target_image_id}"])
        current_env = current.get("Config", {}).get("Env", [])
        allowed_env = {
            "UPDATE_TRUSTED_REPOSITORY", "UPDATE_COMPOSE_FILE", "UPDATE_ENV_FILE",
            "UPDATE_STATE_DIR", "UPDATE_BACKUP_DIR", "UPDATE_HOST_OVERRIDE_FILE",
            "UPDATE_CONTROL_SOCKET", "UPDATE_CONTROL_GID", "PYTHONPATH",
            "PYTHONUNBUFFERED",
        }
        for entry in current_env:
            if isinstance(entry, str) and entry.split("=", 1)[0] in allowed_env:
                create.extend(["--env", entry])
        for destination in sorted(expected_destinations):
            item = by_destination[destination]
            create.extend(["--mount", self._handoff_mount_spec(item, destination)])
        create.append(target_image)
        self.runner.run(create, timeout=120)

        # A durable helper based on the already-running, locally present updater
        # image performs an idempotent name swap after this process has returned
        # its last durable stage. It has its own restart policy, so a Docker-daemon
        # or host restart resumes reconciliation instead of leaving no supervisor.
        command = self._handoff_helper_script()
        self.runner.run(
            [
                "docker", "run", "--detach", "--restart", "unless-stopped",
                "--name", helper_name,
                "--network", "none",
                "--volume", "/var/run/docker.sock:/var/run/docker.sock:rw",
                "--entrypoint", "/bin/sh",
                current_image,
                "-c", command, "agentic-soc-updater-handoff",
                helper_name, self.config.updater_service, next_name, previous_name,
                target_image_id, current_image,
            ],
            timeout=60,
        )

    @staticmethod
    def _handoff_helper_script() -> str:
        """Return the fixed POSIX-shell self-handoff transaction.

        Names and immutable image IDs arrive as positional arguments supplied by
        this module, never from a release plan or HTTP request. Every transition is
        restart-safe: the script first observes which rename/start operation already
        completed, then advances or restores from that state.
        """

        return """set -eu
helper="$1"
active="$2"
next="$3"
previous="$4"
target_image="$5"
prior_image="$6"
exists() { docker inspect "$1" >/dev/null 2>&1; }
image() { docker inspect --format '{{.Image}}' "$1" 2>/dev/null || true; }
finish() {
  docker update --restart=no "$helper" >/dev/null 2>&1 || true
  exit "$1"
}
restore_previous() {
  if exists "$active" && [ "$(image "$active")" = "$target_image" ]; then
    docker rm --force "$active" >/dev/null 2>&1 || true
  fi
  if ! exists "$active" && exists "$previous"; then
    docker rename "$previous" "$active" || return 1
  fi
  if exists "$active" && [ "$(image "$active")" = "$prior_image" ]; then
    docker start "$active" >/dev/null 2>&1 || return 1
    docker rm --force "$next" >/dev/null 2>&1 || true
    return 0
  fi
  return 1
}
sleep 2
attempt=0
while [ "$attempt" -lt 180 ]; do
  if exists "$active" && [ "$(image "$active")" = "$target_image" ]; then
    docker start "$active" >/dev/null 2>&1 || true
    health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$active" 2>/dev/null || true)"
    if [ "$health" = healthy ]; then
      docker rm --force "$previous" >/dev/null 2>&1 || true
      docker rm --force "$next" >/dev/null 2>&1 || true
      finish 0
    fi
    if [ "$health" = unhealthy ]; then
      restore_previous && finish 1
    fi
  elif exists "$active" && [ "$(image "$active")" = "$prior_image" ]; then
    if exists "$next" && [ "$(image "$next")" = "$target_image" ] && ! exists "$previous"; then
      docker stop --time 20 "$active" >/dev/null || { docker restart "$active" >/dev/null 2>&1 || true; finish 1; }
      docker rename "$active" "$previous" || { docker start "$active" >/dev/null 2>&1 || true; finish 1; }
    elif ! exists "$next" && ! exists "$previous"; then
      docker start "$active" >/dev/null 2>&1 || true
      finish 1
    else
      restore_previous && finish 1
    fi
  elif ! exists "$active"; then
    if exists "$next" && [ "$(image "$next")" = "$target_image" ]; then
      docker rename "$next" "$active" || true
      docker start "$active" >/dev/null 2>&1 || true
    elif exists "$previous"; then
      restore_previous && finish 1
    fi
  else
    restore_previous && finish 1
  fi
  attempt=$((attempt + 1))
  sleep 2
done
restore_previous && finish 1
exit 1
"""

    @staticmethod
    def _handoff_mount_spec(item: dict[str, Any], destination: str) -> str:
        mount_type = str(item.get("Type", ""))
        if mount_type == "volume":
            # Docker inspect's Source is the engine-private data directory;
            # recreating a named mount must use Name or Docker interprets that
            # host path as a new volume name/path.
            source = str(item.get("Name", ""))
            if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,254}", source):
                raise RuntimeFailure("current updater contains an invalid named volume")
        elif mount_type == "bind":
            source = str(item.get("Source", ""))
            if not os.path.isabs(source) or any(character in source for character in "\n\r"):
                raise RuntimeFailure("current updater contains an invalid bind mount")
        else:
            raise RuntimeFailure("current updater contains an unsupported mount")
        spec = f"type={mount_type},src={source},dst={destination}"
        if item.get("RW") is False:
            spec += ",readonly"
        return spec

    def _container_exists(self, name: str) -> bool:
        try:
            self._container(name)
            return True
        except RuntimeFailure:
            return False

    def backup_postgres(self, job_id: str) -> dict[str, Any]:
        env = self._container(self.config.postgres_container).get("Config", {}).get("Env", [])
        parsed = dict(item.split("=", 1) for item in env if isinstance(item, str) and "=" in item)
        user = parsed.get("POSTGRES_USER", "tlsoc")
        database = parsed.get("POSTGRES_DB", "tlsoc")
        identifier = re.compile(r"^[A-Za-z_][A-Za-z0-9_$-]{0,62}$")
        if not identifier.fullmatch(user) or not identifier.fullmatch(database):
            raise RuntimeFailure("PostgreSQL user or database name is outside the supported identifier contract")
        backup = self.config.backup_dir / f"{job_id}.dump"
        with backup.open("wb") as handle:
            os.chmod(backup, 0o600)
            self.runner.run(
                ["docker", "exec", self.config.postgres_container, "pg_dump", "--format=custom", "--no-owner", "--no-acl", "--username", user, "--dbname", database],
                timeout=1200,
                stdout_file=handle,
            )
            handle.flush()
            os.fsync(handle.fileno())
        if backup.stat().st_size < 128:
            raise RuntimeFailure("PostgreSQL backup is unexpectedly empty")
        digest = hashlib.sha256()
        with backup.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        # With no filename argument pg_restore reads the archive from stdin.
        # Passing a literal '-' is not its documented stdin contract.
        with backup.open("rb") as handle:
            self.runner.run(
                ["docker", "exec", "--interactive", self.config.postgres_container, "pg_restore", "--list"],
                timeout=300,
                stdin_file=handle,
            )
        return {
            "path": str(backup),
            "sha256": digest.hexdigest(),
            "bytes": backup.stat().st_size,
            "database": database,
            "user": user,
            "verified": True,
        }

    def switch_backend(self) -> None:
        self._compose("up", "--detach", "--no-deps", "--no-build", "--force-recreate", self.config.backend_service, timeout=600)

    def quiesce_backend(self) -> None:
        """Stop the only application writer before the rollback snapshot."""

        self._compose("stop", "--timeout", "30", self.config.backend_service, timeout=120)
        backend = self._container(self.config.backend_container)
        if backend.get("State", {}).get("Running") is True:
            raise RuntimeFailure("backend writer remained active after quiesce")

    def switch_webui(self) -> None:
        self._compose("up", "--detach", "--no-deps", "--no-build", "--force-recreate", self.config.webui_service, timeout=600)

    @staticmethod
    def _get_json(url: str, timeout: int = 5) -> dict[str, Any]:
        try:
            with urllib.request.urlopen(url, timeout=timeout) as response:
                if response.status != 200:
                    raise RuntimeFailure(f"identity endpoint returned HTTP {response.status}")
                payload = response.read(131073)
        except (OSError, urllib.error.URLError) as exc:
            raise RuntimeFailure("identity endpoint is unavailable") from exc
        if len(payload) > 131072:
            raise RuntimeFailure("identity response exceeded the size limit")
        try:
            value = json.loads(payload)
        except json.JSONDecodeError as exc:
            raise RuntimeFailure("identity endpoint returned invalid JSON") from exc
        if not isinstance(value, dict):
            raise RuntimeFailure("identity endpoint returned a non-object")
        return value

    def _wait_health(self, container: str, timeout_seconds: int) -> None:
        deadline = time.monotonic() + timeout_seconds
        last = "unknown"
        while time.monotonic() < deadline:
            try:
                state = self._container(container).get("State", {})
                last = state.get("Health", {}).get("Status", "none")
                if state.get("Running") and last == "healthy":
                    return
            except RuntimeFailure:
                pass
            time.sleep(2)
        raise RuntimeFailure(f"{container} did not become healthy (last status: {last})")

    def verify_backend(self, plan: UpgradePlan) -> None:
        self._wait_health(self.config.backend_container, plan.backend_timeout_seconds)
        ready = self._get_json("http://tlsoc-backend:8088/api/health/ready")
        build = self._get_json("http://tlsoc-backend:8088/api/health/build-info")
        if ready.get("ready") is not True or ready.get("version") != plan.version:
            raise RuntimeFailure("backend readiness does not match target release")
        expected = {"version": plan.version, "release_channel": "stable", "commit_sha": plan.commit_sha}
        if any(build.get(key) != value for key, value in expected.items()):
            raise RuntimeFailure("backend build identity does not match signed target")

    def verify_webui(self, plan: UpgradePlan) -> None:
        self._wait_health(self.config.webui_container, plan.webui_timeout_seconds)
        manifest = self._get_json("http://tlsoc-webui/release.json")
        expected = {"version": plan.version, "channel": "stable", "commitSha": plan.commit_sha}
        if any(manifest.get(key) != value for key, value in expected.items()):
            raise RuntimeFailure("Web release identity does not match signed target")
        with urllib.request.urlopen("http://tlsoc-webui/index.html", timeout=5) as response:
            if response.status != 200 or not response.read(262145):
                raise RuntimeFailure("Web entry document is unavailable")
        documentation_line = ".".join(plan.version.split(".")[:2])
        with urllib.request.urlopen(
            f"http://tlsoc-webui/docs/{documentation_line}/", timeout=5
        ) as response:
            if response.status != 200 or b'name="generator" content="mkdocs-' not in response.read(262145):
                raise RuntimeFailure("version-matched Help Center is unavailable")

    def observe(self, plan: UpgradePlan) -> None:
        deadline = time.monotonic() + plan.observation_seconds
        while time.monotonic() < deadline:
            self.verify_backend(plan)
            self.verify_webui(plan)
            time.sleep(min(5, max(1, deadline - time.monotonic())))

    def rollback(self, snapshot: dict[str, Any], backup: dict[str, Any] | None, *, restore_database: bool) -> None:
        backend_image = str(snapshot.get("backend_image_id", ""))
        webui_image = str(snapshot.get("webui_image_id", ""))
        if not re.fullmatch(r"sha256:[0-9a-f]{64}", backend_image) or not re.fullmatch(r"sha256:[0-9a-f]{64}", webui_image):
            raise RuntimeFailure("rollback snapshot does not contain exact prior image IDs")
        # Keep whichever immutable supervisor image is actually serving this
        # rollback. After a healthy handoff this is the signed target; if the
        # handoff helper restored the old supervisor, this is the exact old ID.
        updater_image = self._updater_image_for_rollback(snapshot)
        source = (
            "# Automatic rollback generated by the Agentic SOC updater.\nservices:\n"
            f"  {self.config.updater_service}:\n    image: {updater_image}\n"
            f"  {self.config.backend_service}:\n    image: {backend_image}\n"
            f"  {self.config.webui_service}:\n    image: {webui_image}\n"
        )
        self._write_override(source, suffix="rollback")
        self._compose("stop", self.config.backend_service, self.config.webui_service, timeout=300)
        if restore_database:
            if (
                not backup
                or backup.get("verified") is not True
                or backup.get("writer_quiesced") is not True
            ):
                raise RuntimeFailure("verified quiesced database backup is unavailable for rollback")
            path = Path(str(backup.get("path", "")))
            if not path.is_file():
                raise RuntimeFailure("database backup file is unavailable")
            digest = hashlib.sha256()
            with path.open("rb") as handle:
                for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                    digest.update(chunk)
            if digest.hexdigest() != backup.get("sha256"):
                raise RuntimeFailure("database backup checksum changed")
            with path.open("rb") as handle:
                self.runner.run(
                    [
                        "docker", "exec", "--interactive", self.config.postgres_container,
                        "pg_restore", "--clean", "--if-exists", "--no-owner", "--no-acl",
                        "--exit-on-error", "--single-transaction",
                        "--username", str(backup["user"]), "--dbname", str(backup["database"]),
                    ],
                    timeout=1200,
                    stdin_file=handle,
                )
        self._compose("up", "--detach", "--no-deps", "--no-build", "--force-recreate", self.config.backend_service, timeout=600)
        self._wait_health(self.config.backend_container, 600)
        self._compose("up", "--detach", "--no-deps", "--no-build", "--force-recreate", self.config.webui_service, timeout=600)
        self._wait_health(self.config.webui_container, 300)
        restored = self.installed_identity()
        expected_version = str(snapshot.get("version", ""))
        expected_commit = str(snapshot.get("commit_sha", ""))
        if (
            not expected_version
            or not expected_commit
            or restored.get("version") != expected_version
            or restored.get("commit_sha") != expected_commit
        ):
            raise RuntimeFailure("rollback health passed but prior release identity was not restored")

    def _updater_image_for_rollback(self, snapshot: dict[str, Any]) -> str:
        try:
            current_image = str(
                self._container(self.config.updater_service).get("Image", "")
            )
        except RuntimeFailure:
            current_image = ""
        if re.fullmatch(r"sha256:[0-9a-f]{64}", current_image):
            return current_image

        prior_image = str(snapshot.get("updater_image_id", ""))
        if re.fullmatch(r"sha256:[0-9a-f]{64}", prior_image):
            return prior_image
        raise RuntimeFailure("rollback has no immutable updater image ID")


def download(url: str, destination: Path, *, maximum_bytes: int) -> None:
    if not download_host_allowed(url):
        raise RuntimeFailure("release asset URL is not trusted")
    opener = urllib.request.build_opener(SafeRedirectHandler())
    request = urllib.request.Request(url, headers={"Accept": "application/octet-stream", "User-Agent": "Agentic-SOC-Updater/1"})
    try:
        with opener.open(request, timeout=30) as response:
            payload = response.read(maximum_bytes + 1)
    except (OSError, urllib.error.URLError) as exc:
        raise RuntimeFailure("could not download signed release asset") from exc
    if not payload or len(payload) > maximum_bytes:
        raise RuntimeFailure("release asset is empty or exceeds the size limit")
    temporary = destination.with_suffix(destination.suffix + ".tmp")
    temporary.write_bytes(payload)
    os.chmod(temporary, 0o600)
    os.replace(temporary, destination)
