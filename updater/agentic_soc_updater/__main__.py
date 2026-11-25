from __future__ import annotations

import os
from pathlib import Path

from .contract import REPOSITORY_RE
from .runtime import ComposeRuntime, RuntimeConfig
from .server import serve
from .service import UpdateService
from .store import JsonStore


def required(name: str, default: str | None = None) -> str:
    value = os.getenv(name, default or "").strip()
    if not value:
        raise SystemExit(f"{name} is required")
    return value


def main() -> None:
    repository = required("UPDATE_TRUSTED_REPOSITORY", "ARYDESTROYER/Kavach-AgenticSOC")
    if not REPOSITORY_RE.fullmatch(repository):
        raise SystemExit("UPDATE_TRUSTED_REPOSITORY must be owner/name")
    state_dir = Path(required("UPDATE_STATE_DIR", "/var/lib/agentic-soc-updater"))
    config = RuntimeConfig(
        trusted_repository=repository,
        compose_file=Path(required("UPDATE_COMPOSE_FILE", "/deployment/docker-compose.yml")),
        env_file=Path(required("UPDATE_ENV_FILE", "/deployment/.env")),
        state_dir=state_dir,
        backup_dir=Path(required("UPDATE_BACKUP_DIR", "/var/backups/agentic-soc")),
        host_override_file=Path(
            required(
                "UPDATE_HOST_OVERRIDE_FILE",
                "/deployment/host-runtime/active-release.compose.yml",
            )
        ),
    )
    store = JsonStore(state_dir)
    runtime = ComposeRuntime(config)
    service = UpdateService(store, runtime, repository)
    serve(
        Path(required("UPDATE_CONTROL_SOCKET", "/run/agentic-soc-updater/control.sock")),
        int(required("UPDATE_CONTROL_GID", "10001")),
        service,
    )


if __name__ == "__main__":
    main()
