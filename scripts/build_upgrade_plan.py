#!/usr/bin/env python3
"""Build the canonical, command-free Agentic SOC upgrade plan."""

from __future__ import annotations

import argparse
from datetime import datetime
import hashlib
import json
from pathlib import Path
import re
import sys


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "updater"))

from agentic_soc_updater.contract import DIGEST_RE, validate_plan  # noqa: E402


def image(value: str, repository: str, component: str) -> tuple[str, str]:
    prefix = f"ghcr.io/{repository.lower()}/{component}@"
    if not value.startswith(prefix):
        raise argparse.ArgumentTypeError(f"{component} must use {prefix}<digest>")
    digest = value[len(prefix):]
    if not DIGEST_RE.fullmatch(digest):
        raise argparse.ArgumentTypeError(f"{component} is not pinned by sha256 digest")
    return value, digest


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--version", required=True)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--commit-sha", required=True)
    parser.add_argument("--published-at", required=True)
    parser.add_argument("--repository", required=True)
    parser.add_argument("--updater-image", required=True)
    parser.add_argument("--backend-image", required=True)
    parser.add_argument("--webui-image", required=True)
    # v0.1.1 is the final pre-supervisor Stable release and is admitted only
    # through the explicit host-authorized bootstrap. Newer installations use
    # the same plan through the Console.
    parser.add_argument("--min-version", default="0.1.1")
    parser.add_argument("--max-version-exclusive", default="0.3.0")
    parser.add_argument("--backend-timeout", type=int, default=300)
    parser.add_argument("--webui-timeout", type=int, default=180)
    parser.add_argument("--observation-seconds", type=int, default=30)
    parser.add_argument(
        "--compose-file",
        type=Path,
        default=ROOT / "deploy" / "docker-compose.agnostic.yml",
    )
    parser.add_argument(
        "--compose-baseline",
        type=Path,
        default=ROOT / "deploy" / "update-base-v1.sha256",
    )
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    try:
        datetime.fromisoformat(args.published_at.replace("Z", "+00:00"))
    except ValueError as exc:
        parser.error(f"--published-at must be ISO-8601: {exc}")
    if not re.fullmatch(r"[0-9a-f]{40}", args.commit_sha):
        parser.error("--commit-sha must be a full lowercase commit SHA")
    if not args.compose_file.is_file():
        parser.error("--compose-file must be a readable canonical Compose file")
    compose_sha256 = hashlib.sha256(args.compose_file.read_bytes()).hexdigest()
    if not args.compose_baseline.is_file():
        parser.error("--compose-baseline must be a readable pinned v1 base hash")
    baseline_sha256 = args.compose_baseline.read_text(encoding="utf-8").strip()
    if not re.fullmatch(r"[0-9a-f]{64}", baseline_sha256):
        parser.error("--compose-baseline must contain one lowercase SHA-256 digest")
    if compose_sha256 != baseline_sha256:
        parser.error(
            "canonical Compose changed from the supervised-update v1 baseline; "
            "a new updater protocol/bootstrap contract is required"
        )

    labels = {
        "org.opencontainers.image.version": args.version,
        "org.opencontainers.image.revision": args.commit_sha,
        "org.opencontainers.image.source": f"https://github.com/{args.repository}",
        "dev.tlsoc.release.channel": "stable",
        "io.agentic-soc.state.schema": "1",
    }
    components = {}
    for name, reference in (
        ("updater", args.updater_image),
        ("backend", args.backend_image),
        ("webui", args.webui_image),
    ):
        try:
            reference, digest = image(reference, args.repository, name)
        except argparse.ArgumentTypeError as exc:
            parser.error(str(exc))
        components[name] = {"image": reference, "digest": digest, "labels": labels}

    plan = {
        "schema_version": 1,
        "product": "agentic-soc",
        "release": {
            "version": args.version,
            "tag": args.tag,
            "channel": "stable",
            "commit_sha": args.commit_sha,
            "published_at": args.published_at,
        },
        "compatibility": {
            "from": {"min_inclusive": args.min_version, "max_exclusive": args.max_version_exclusive},
            "state_backends": ["postgres"],
            "state_schema": 1,
            "compose_sha256": compose_sha256,
            "minimum_updater_protocol": 1,
            "backup_required": True,
            "migration": {"strategy": "none"},
        },
        "components": components,
        "rollout": {
            "backend_timeout_seconds": args.backend_timeout,
            "webui_timeout_seconds": args.webui_timeout,
            "observation_seconds": args.observation_seconds,
        },
    }
    validate_plan(plan, args.repository)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(plan, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
