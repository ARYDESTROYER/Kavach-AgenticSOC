#!/usr/bin/env python3
"""Fail-closed structural policy for Agentic SOC GitHub Actions workflows."""

from __future__ import annotations

import re
import sys
from pathlib import Path
from typing import Any

import yaml


ROOT = Path(__file__).resolve().parents[1]
WORKFLOW_DIR = ROOT / ".github" / "workflows"
SHA_REF = re.compile(r"^[0-9a-f]{40}$")
IMAGE_REF = re.compile(r"^.+@sha256:[0-9a-f]{64}$")
EXPECTED_WORKFLOWS = {"ci.yml", "docs.yml", "release.yml"}
SHIPPING_DOCKERFILES = (
    ROOT / "backend" / "Dockerfile",
    ROOT / "webui" / "Dockerfile",
    ROOT / "updater" / "Dockerfile",
)
POSTGRES_ACCEPTANCE_STEP = "Run the PostgreSQL state acceptance tests"
#: Flags that turn the rollback lane into a one-off rehearsal or drop its
#: self-forward scenario; the required lane never passes them.
ROLLBACK_REHEARSAL_FLAGS = ("--pinned-only", "--previous-backend", "--previous-release")


def _postgres_acceptance_modules() -> list[str]:
    """Every PostgreSQL-only backend test module, relative to ``backend/``.

    These modules skip themselves without a PostgreSQL URL, so the offline suite
    cannot stand in for them: each one must run in the live-service acceptance step.
    """
    tests = ROOT / "backend" / "tests"
    return sorted(f"tests/{path.name}" for path in tests.glob("test_postgres_*.py"))


class UniqueKeyLoader(yaml.SafeLoader):
    """Safe YAML loader that rejects duplicate keys instead of keeping the last."""


def _construct_unique_mapping(
    loader: UniqueKeyLoader,
    node: yaml.nodes.MappingNode,
    deep: bool = False,
) -> dict[Any, Any]:
    mapping: dict[Any, Any] = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if key in mapping:
            mark = key_node.start_mark
            raise ValueError(
                f"{mark.name}:{mark.line + 1}:{mark.column + 1}: duplicate key {key!r}"
            )
        mapping[key] = loader.construct_object(value_node, deep=deep)
    return mapping


UniqueKeyLoader.add_constructor(
    yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG,
    _construct_unique_mapping,
)


def _load(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as handle:
        document = yaml.load(handle, Loader=UniqueKeyLoader)
    if not isinstance(document, dict):
        raise ValueError(f"{path}: workflow root must be a mapping")
    return document


def _walk(value: Any):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from _walk(child)
    elif isinstance(value, list):
        for child in value:
            yield from _walk(child)


def _workflow_paths() -> list[Path]:
    paths = sorted({*WORKFLOW_DIR.glob("*.yml"), *WORKFLOW_DIR.glob("*.yaml")})
    names = {path.name for path in paths}
    missing = sorted(EXPECTED_WORKFLOWS - names)
    unknown = sorted(names - EXPECTED_WORKFLOWS)
    if missing or unknown:
        raise ValueError(
            "workflow allowlist drift; "
            f"missing={missing}, unknown={unknown}. "
            "Add an explicit policy before changing the workflow surface."
        )
    return paths


def _assert_common(path: Path, workflow: dict[str, Any]) -> None:
    jobs = workflow.get("jobs")
    if not isinstance(jobs, dict) or not jobs:
        raise ValueError(f"{path}: jobs must be a non-empty mapping")
    for job_id, job in jobs.items():
        if not isinstance(job, dict):
            raise ValueError(f"{path}: job {job_id!r} must be a mapping")
        if "timeout-minutes" not in job:
            raise ValueError(f"{path}: job {job_id!r} has no timeout-minutes")

    for mapping in _walk(workflow):
        if "continue-on-error" in mapping:
            raise ValueError(f"{path}: continue-on-error is forbidden")
        uses = mapping.get("uses")
        if not isinstance(uses, str) or uses.startswith("./"):
            continue
        if "@" not in uses:
            raise ValueError(f"{path}: action reference lacks an immutable ref: {uses}")
        _action, ref = uses.rsplit("@", 1)
        if not SHA_REF.fullmatch(ref):
            raise ValueError(f"{path}: action must use a reviewed 40-char SHA: {uses}")


def _assert_ci(path: Path, workflow: dict[str, Any]) -> None:
    if workflow.get("permissions") != {"contents": "read"}:
        raise ValueError(f"{path}: CI permissions must be exactly contents: read")
    trigger = workflow.get("on", workflow.get(True))
    if not isinstance(trigger, dict) or "pull_request_target" in trigger:
        raise ValueError(f"{path}: unsafe or malformed CI trigger")
    if "pull_request" not in trigger or "push" not in trigger:
        raise ValueError(f"{path}: CI must run for pull_request and push")

    jobs = workflow["jobs"]
    bootstrap_bash32 = jobs.get("bootstrap-bash32")
    if not isinstance(bootstrap_bash32, dict):
        raise ValueError(f"{path}: macOS Bash 3.2 bootstrap gate is missing")
    if bootstrap_bash32.get("runs-on") != "macos-15":
        raise ValueError(f"{path}: bootstrap portability gate must run on macos-15")
    bootstrap_run = _job_run_text(bootstrap_bash32)
    for marker in (
        "/bin/bash -c",
        '= "3.2"',
        "/bin/bash -n scripts/bootstrap-updater.sh",
        "python3 scripts/test_bootstrap_bash32.py",
    ):
        if marker not in bootstrap_run:
            raise ValueError(
                f"{path}: macOS Bash 3.2 bootstrap gate lacks {marker!r}"
            )
    container_images = jobs.get("container-images")
    if not isinstance(container_images, dict):
        raise ValueError(f"{path}: shipping-image acceptance job is missing")
    webui_smoke = next(
        (
            step
            for step in container_images.get("steps", [])
            if isinstance(step, dict)
            and step.get("name") == "Smoke the shipping Web Console health contract"
        ),
        None,
    )
    if not isinstance(webui_smoke, dict) or "matrix.component == 'webui'" not in str(
        webui_smoke.get("if", "")
    ):
        raise ValueError(f"{path}: shipping Web Console health smoke is missing or unscoped")
    webui_smoke_run = str(webui_smoke.get("run", ""))
    for marker in (
        "docker run --detach",
        "--health-interval",
        ".State.Health.Status",
        "curl --fail",
    ):
        if marker not in webui_smoke_run:
            raise ValueError(
                f"{path}: shipping Web Console health smoke lacks {marker!r}"
            )
    identity_step = next(
        (
            step
            for step in container_images.get("steps", [])
            if isinstance(step, dict)
            and step.get("name") == "Verify image identity and runtime contract"
        ),
        None,
    )
    identity_run = str(identity_step.get("run", "")) if isinstance(identity_step, dict) else ""
    if 'docker run --rm --entrypoint python "${IMAGE}" -m pip check' not in identity_run:
        raise ValueError(
            f"{path}: shipping backend image must pass its installed dependency contract"
        )
    if 'version("wheel") == "0.45.1"' not in identity_run:
        raise ValueError(
            f"{path}: shipping backend image must retain the reviewed Wheel version"
        )
    if '.Config.User == "0:10001"' not in identity_run:
        raise ValueError(
            f"{path}: shipping updater image must inherit the backend control-socket GID"
        )
    if (
        'index("TUF_ROOT=/var/lib/agentic-soc-updater/sigstore-root")'
        not in identity_run
    ):
        raise ValueError(
            f"{path}: shipping updater image must place Sigstore trust state "
            "on the writable updater-state volume"
        )
    updater_smoke = next(
        (
            step
            for step in container_images.get("steps", [])
            if isinstance(step, dict)
            and step.get("name")
            == "Smoke updater control socket without Linux capabilities"
        ),
        None,
    )
    if not isinstance(updater_smoke, dict) or "matrix.component == 'updater'" not in str(
        updater_smoke.get("if", "")
    ):
        raise ValueError(f"{path}: updater control-socket runtime smoke is missing or unscoped")
    updater_smoke_run = str(updater_smoke.get("run", ""))
    for marker in (
        "--read-only",
        "--cap-drop ALL",
        "--security-opt no-new-privileges:true",
        "--user 10001:10001",
        "stat.S_ISSOCK(details.st_mode)",
        "details.st_uid == 0",
        "details.st_gid == 10001",
        "stat.S_IMODE(details.st_mode) == 0o660",
        "GET /v1/status HTTP/1.1",
        'test "${TUF_ROOT}" = /var/lib/agentic-soc-updater/sigstore-root',
        'test -w "${TUF_ROOT}"',
    ):
        if marker not in updater_smoke_run:
            raise ValueError(
                f"{path}: updater control-socket runtime smoke lacks {marker!r}"
            )
    for job_id, job in jobs.items():
        services = job.get("services", {}) if isinstance(job, dict) else {}
        if not isinstance(services, dict):
            raise ValueError(f"{path}: job {job_id!r} services must be a mapping")
        for service_id, service in services.items():
            image_ref = service.get("image") if isinstance(service, dict) else None
            if not isinstance(image_ref, str) or not IMAGE_REF.fullmatch(image_ref):
                raise ValueError(
                    f"{path}: service {job_id}.{service_id} must use an image digest"
                )
    _assert_postgres_acceptance(path, jobs)
    _assert_rollback_lane(path, jobs)
    _assert_verdict_stability(path, jobs)
    aggregate = jobs.get("ci")
    if not isinstance(aggregate, dict) or aggregate.get("name") != "CI passed":
        raise ValueError(f"{path}: fail-closed aggregate job 'ci' is missing")
    if "always()" not in str(aggregate.get("if", "")):
        raise ValueError(f"{path}: CI passed must run under always()")

    needs = aggregate.get("needs")
    if isinstance(needs, str):
        needs = [needs]
    if not isinstance(needs, list):
        raise ValueError(f"{path}: CI passed needs must be a list")
    required = set(jobs) - {"ci"}
    if set(needs) != required or len(needs) != len(required):
        missing = sorted(required - set(needs))
        extra = sorted(set(needs) - required)
        raise ValueError(f"{path}: CI passed dependency drift; missing={missing}, extra={extra}")

    run_text = "\n".join(
        str(step.get("run", ""))
        for step in aggregate.get("steps", [])
        if isinstance(step, dict)
    )
    for job_id in sorted(required):
        marker = f"needs.{job_id}.result"
        if marker not in run_text:
            raise ValueError(f"{path}: CI passed does not inspect {marker}")
    if '== "success"' not in run_text:
        raise ValueError(f"{path}: CI passed does not require explicit success")


def _assert_release(path: Path, workflow: dict[str, Any]) -> None:
    trigger = workflow.get("on", workflow.get(True))
    if not isinstance(trigger, dict) or set(trigger) != {"push"}:
        raise ValueError(
            f"{path}: Stable release must use only the direct immutable-tag push "
            "trigger; it may not depend on documentation publication"
        )
    tags = ((trigger or {}).get("push") or {}).get("tags") if isinstance(trigger, dict) else None
    if tags != ["v*"]:
        raise ValueError(f"{path}: release publication must run only for v* tags")
    concurrency = workflow.get("concurrency")
    if not isinstance(concurrency, dict) or concurrency.get("cancel-in-progress") is not False:
        raise ValueError(f"{path}: Stable release publication must be non-cancellable")
    publish = (workflow.get("jobs") or {}).get("publish")
    run_text = _job_run_text(publish)
    if "workflows/docs.yml/runs" in run_text:
        raise ValueError(
            f"{path}: Stable release may not wait on documentation publication"
        )
    for marker in ("workflows/ci.yml/runs", 'CI passed', 'conclusion == "success"'):
        if marker not in run_text:
            raise ValueError(f"{path}: Stable release does not prove exact tag CI: {marker}")

    steps = publish.get("steps") if isinstance(publish, dict) else None
    if not isinstance(steps, list):
        raise ValueError(f"{path}: Stable release steps are missing")

    def named_step(name: str) -> tuple[int, dict[str, Any]]:
        matches = [
            (index, step)
            for index, step in enumerate(steps)
            if isinstance(step, dict) and step.get("name") == name
        ]
        if len(matches) != 1:
            raise ValueError(
                f"{path}: Stable release requires exactly one {name!r} step"
            )
        return matches[0]

    def require_typed_release_booleans(
        step_name: str,
        fields: tuple[str, ...],
    ) -> None:
        _index, step = named_step(step_name)
        step_run = str(step.get("run", ""))
        for field in fields:
            if (
                "scripts/read_release_state_boolean.py" not in step_run
                or f"--field {field}" not in step_run
            ):
                raise ValueError(
                    f"{path}: {step_name} must read {field!r} through the typed "
                    "release-state boolean parser"
                )
        unsafe = re.search(
            r"jq\s+-[^\n]*r[^\n]*['\"]\."
            r"(?:release_exists|plan_exists|bundle_exists)['\"]",
            step_run,
        )
        if unsafe is not None:
            raise ValueError(
                f"{path}: {step_name} uses jq truthiness for a release-state "
                "boolean; valid false must not abort and untyped values must fail closed"
            )

    require_typed_release_booleans(
        "Inspect and safely recover an exact draft release",
        ("release_exists", "plan_exists", "bundle_exists"),
    )
    require_typed_release_booleans(
        "Stage, verify, and atomically publish the GitHub Release",
        ("plan_exists", "bundle_exists"),
    )

    boolean_reader = ROOT / "scripts" / "read_release_state_boolean.py"
    if not boolean_reader.is_file():
        raise ValueError(f"{path}: typed release-state boolean parser is missing")
    boolean_reader_source = boolean_reader.read_text(encoding="utf-8")
    for marker in (
        'BOOLEAN_FIELDS = frozenset(("release_exists", "plan_exists", "bundle_exists"))',
        "type(document[field]) is not bool",
        'print("true" if value else "false")',
    ):
        if marker not in boolean_reader_source:
            raise ValueError(
                f"{path}: typed release-state boolean parser contract drifted: "
                f"missing {marker!r}"
            )

    candidate_marker = "candidate-${{ github.run_id }}-${{ github.run_attempt }}"
    build_steps = {
        "backend": "Build and publish backend by immutable digest",
        "webui": "Build and publish Web Console by immutable digest",
        "updater": "Build and publish update supervisor by immutable digest",
    }
    for component, name in build_steps.items():
        _index, step = named_step(name)
        with_config = step.get("with")
        tags = str(with_config.get("tags", "")) if isinstance(with_config, dict) else ""
        if (
            f"/{component}:{candidate_marker}" not in tags
            or "steps.release.outputs.tag" in tags
        ):
            raise ValueError(
                f"{path}: {component} must publish only a non-Stable candidate tag "
                "until every signed release artifact passes"
            )

    sign_index, _sign_step = named_step(
        "Sign new images and verify all immutable image signatures"
    )
    anonymous_index, anonymous_step = named_step(
        "Prove anonymous pullability and exact OCI release labels"
    )
    anonymous_run = str(anonymous_step.get("run", ""))
    anonymous_markers = (
        'anonymous_docker_config="$(mktemp -d)"',
        "unset DOCKER_AUTH_CONFIG REGISTRY_AUTH_FILE",
        'export DOCKER_CONFIG="${anonymous_docker_config}"',
        '[[ ! -e "${DOCKER_CONFIG}/config.json" ]]',
        "for platform in linux/amd64 linux/arm64",
        'docker pull --platform "${platform}" "${reference}"',
        'docker image rm "${reference}"',
        'EXPECTED_PLATFORMS = {("linux", "amd64"), ("linux", "arm64")}',
        "anonymous GHCR token unavailable",
        "require_digest(raw_index, digest",
        "raw_manifest, _ = fetch(",
        "raw_config, _ = fetch(",
        "OCI label mismatch",
    )
    for marker in anonymous_markers:
        if marker not in anonymous_run:
            raise ValueError(
                f"{path}: anonymous image gate lacks isolated multi-platform "
                "pull and registry proof "
                f"contract {marker!r}"
            )
    pull_index = anonymous_run.index(
        'docker pull --platform "${platform}" "${reference}"'
    )
    eviction_index = anonymous_run.index('docker image rm "${reference}"')
    if eviction_index <= pull_index:
        raise ValueError(
            f"{path}: anonymous image gate must evict the exact digest reference "
            "after each platform pull"
        )
    anonymous_env = anonymous_step.get("env", {})
    expected_anonymous_env = {
        "BACKEND",
        "WEBUI",
        "UPDATER",
        "EXPECTED_VERSION",
        "EXPECTED_CREATED",
    }
    if (
        not isinstance(anonymous_env, dict)
        or set(anonymous_env) != expected_anonymous_env
        or any(
            marker in anonymous_run
            for marker in ("docker login", "secrets.", "github.token")
        )
    ):
        raise ValueError(f"{path}: anonymous image gate may not receive publisher credentials")

    plan_index, _plan_step = named_step(
        "Verify the canonical upgrade plan before draft staging"
    )
    constrained_index, constrained_step = named_step(
        "Verify the signed plan inside the constrained update supervisor"
    )
    constrained_run = str(constrained_step.get("run", ""))
    permission_prep_markers = (
        'verification_dir="$(mktemp -d)"',
        "install -m 0444 upgrade-plan.json \\\n"
        '  "${verification_dir}/upgrade-plan.json"',
        "install -m 0444 upgrade-plan.sigstore.json \\\n"
        '  "${verification_dir}/upgrade-plan.sigstore.json"',
        'chmod 0555 "${verification_dir}"',
        "docker run --detach",
    )
    cleanup_guard = 'if [[ -d "${verification_dir}" ]]; then'
    cleanup_permission_restore = 'chmod 0700 "${verification_dir}"'
    cleanup_status_capture = "release_step_status=$?"
    cleanup_trap_disable = "trap - EXIT"
    cleanup_failure_state = "verification_cleanup_status=0"
    cleanup_remaining_init = 'remaining_container=""'
    cleanup_absence_probe = "docker container ls --all"
    cleanup_exact_name_filter = '--filter "name=^/${container}$"'
    cleanup_remaining_check = 'elif [[ -n "${remaining_container}" ]]; then'
    cleanup_safe_guard = "if (( verification_cleanup_status == 0 )); then"
    cleanup_failure_promotion = (
        "if (( release_step_status == 0 && verification_cleanup_status != 0 )); then"
    )
    cleanup_status_exit = 'exit "${release_step_status}"'
    cleanup_registration = "trap cleanup EXIT"
    if constrained_step.get("env") != {
        "UPDATER": "${{ steps.images.outputs.updater }}"
    }:
        raise ValueError(
            f"{path}: constrained updater verification must use the exact "
            "resolved updater digest"
        )
    if constrained_step.get("continue-on-error") or "if" in constrained_step:
        raise ValueError(
            f"{path}: constrained updater verification must be an "
            "unconditional fail-closed release gate"
        )
    for marker in (
        "docker run --detach",
        '--name "${container}"',
        "--read-only",
        "--cap-drop ALL",
        "--security-opt no-new-privileges:true",
        "target=/run/agentic-soc-updater",
        "target=/var/lib/agentic-soc-updater",
        "target=/var/backups/agentic-soc",
        "target=/deployment/host-runtime",
        "target=/verification,readonly",
        *permission_prep_markers[:-1],
        '"${UPDATER}"',
        ".State.Health.Status",
        "docker logs \"${container}\"",
        "exit 1",
        "docker exec \\",
        '--env EXPECTED_IDENTITY="${identity}"',
        'test "${TUF_ROOT}" = /var/lib/agentic-soc-updater/sigstore-root',
        'test -w "${TUF_ROOT}"',
        "test -r /verification/upgrade-plan.json",
        "test -r /verification/upgrade-plan.sigstore.json",
        "cosign verify-blob",
        "upgrade-plan.sigstore.json",
        "upgrade-plan.json",
        "certificate-identity",
        "token.actions.githubusercontent.com",
    ):
        if marker not in constrained_run:
            raise ValueError(
                f"{path}: constrained updater signed-plan verification lacks {marker!r}"
            )
    if any(constrained_run.count(marker) != 1 for marker in permission_prep_markers):
        raise ValueError(
            f"{path}: constrained updater verification preparation must contain "
            "each least-privilege operation exactly once"
        )
    if constrained_run.count(cleanup_permission_restore) != 1:
        raise ValueError(
            f"{path}: constrained updater verification cleanup must restore "
            "the runner-owned fixture's private mode exactly once"
        )
    if constrained_run.count(cleanup_guard) != 1:
        raise ValueError(
            f"{path}: constrained updater verification cleanup must guard the "
            "runner-owned fixture exactly once"
        )
    for marker in (
        cleanup_status_capture,
        cleanup_trap_disable,
        cleanup_failure_state,
        cleanup_remaining_init,
        cleanup_absence_probe,
        cleanup_exact_name_filter,
        cleanup_remaining_check,
        cleanup_safe_guard,
        cleanup_failure_promotion,
        cleanup_status_exit,
        cleanup_registration,
    ):
        if constrained_run.count(marker) != 1:
            raise ValueError(
                f"{path}: constrained updater verification cleanup must preserve "
                f"the release result with {marker!r} exactly once"
            )
    mktemp_index = constrained_run.index(permission_prep_markers[0])
    cleanup_registration_index = constrained_run.index(cleanup_registration)
    first_install_index = constrained_run.index(permission_prep_markers[1])
    if not mktemp_index < cleanup_registration_index < first_install_index:
        raise ValueError(
            f"{path}: constrained updater verification must register cleanup "
            "immediately after creating the runner-owned fixture"
        )
    cleanup_capture_index = constrained_run.index(cleanup_status_capture)
    cleanup_disable_index = constrained_run.index(cleanup_trap_disable)
    cleanup_docker_remove_index = constrained_run.index(
        'docker rm --force "${container}"'
    )
    cleanup_remaining_init_index = constrained_run.index(cleanup_remaining_init)
    cleanup_absence_probe_index = constrained_run.index(cleanup_absence_probe)
    cleanup_remaining_check_index = constrained_run.index(cleanup_remaining_check)
    cleanup_safe_guard_index = constrained_run.index(cleanup_safe_guard)
    cleanup_volume_remove_index = constrained_run.index(
        'docker volume rm --force "${volume}"'
    )
    cleanup_guard_index = constrained_run.index(cleanup_guard)
    cleanup_restore_index = constrained_run.index(cleanup_permission_restore)
    cleanup_remove_index = constrained_run.index('rm -rf -- "${verification_dir}"')
    cleanup_promotion_index = constrained_run.index(cleanup_failure_promotion)
    cleanup_exit_index = constrained_run.index(cleanup_status_exit)
    if not (
        cleanup_capture_index
        < cleanup_disable_index
        < cleanup_docker_remove_index
        < cleanup_remaining_init_index
        < cleanup_absence_probe_index
        < cleanup_remaining_check_index
        < cleanup_safe_guard_index
        < cleanup_volume_remove_index
        < cleanup_guard_index
        < cleanup_restore_index
        < cleanup_remove_index
        < cleanup_promotion_index
        < cleanup_exit_index
    ):
        raise ValueError(
            f"{path}: constrained updater verification cleanup must preserve the "
            "original result, prove the container and bind are absent, restore "
            "private mode, remove the guarded fixture, and return the correct result"
        )
    permission_prep_indices = [
        constrained_run.index(marker) for marker in permission_prep_markers
    ]
    if permission_prep_indices != sorted(permission_prep_indices):
        raise ValueError(
            f"{path}: constrained updater verification preparation must order "
            "mktemp, exact read-only installs, chmod 0555, then docker run"
        )
    for forbidden in (
        "--entrypoint",
        "--env TUF_ROOT",
        "--env HOME",
        "/var/run/docker.sock",
        "continue-on-error",
        "cp upgrade-plan.json upgrade-plan.sigstore.json",
        "chmod 0777",
        "chmod -R",
        "chown ",
    ):
        if forbidden in constrained_run:
            raise ValueError(
                f"{path}: constrained updater signed-plan verification includes "
                f"forbidden runtime override {forbidden!r}"
            )
    publish_index, _publish_step = named_step(
        "Stage, verify, and atomically publish the GitHub Release"
    )
    stable_index, stable_step = named_step(
        "Publish Stable convenience tags after release publication"
    )
    if not plan_index < constrained_index < publish_index:
        raise ValueError(
            f"{path}: constrained updater verification must follow plan signing "
            "and precede release publication"
        )
    if stable_index <= max(
        sign_index,
        anonymous_index,
        plan_index,
        constrained_index,
        publish_index,
    ):
        raise ValueError(
            f"{path}: Stable convenience tags publish before images, anonymous pulls, "
            "the signed plan, and the GitHub Release are verified and published"
        )
    stable_run = str(stable_step.get("run", ""))
    for marker in (
        "for component in backend webui updater",
        'digest="${reference##*@}"',
        'docker buildx imagetools create --tag "${tagged}" "${reference}"',
        '[[ "${tagged_digest}" == "${digest}" ]]',
    ):
        if marker not in stable_run:
            raise ValueError(
                f"{path}: Stable convenience tags are not derived from exact plan "
                f"digests: missing {marker!r}"
            )


def _assert_docs(path: Path, workflow: dict[str, Any]) -> None:
    jobs = workflow.get("jobs") or {}
    publish = jobs.get("publish")
    if not isinstance(publish, dict):
        raise ValueError(f"{path}: documentation publication job is missing")
    if publish.get("permissions") != {"actions": "read", "contents": "write"}:
        raise ValueError(f"{path}: documentation publisher permissions drifted")
    run_text = _job_run_text(publish)
    for marker in ("workflows/ci.yml/runs", 'CI passed', 'conclusion == "success"'):
        if marker not in run_text:
            raise ValueError(f"{path}: documentation may publish before exact tag CI: {marker}")

    steps = publish.get("steps")
    if not isinstance(steps, list):
        raise ValueError(f"{path}: documentation publisher steps are missing")

    def named_step(name: str) -> tuple[int, dict[str, Any]]:
        matches = [
            (index, step)
            for index, step in enumerate(steps)
            if isinstance(step, dict) and step.get("name") == name
        ]
        if len(matches) != 1:
            raise ValueError(
                f"{path}: documentation publication requires exactly one {name!r} step"
            )
        return matches[0]

    ci_index, _ci_step = named_step(
        "Require the exact tag CI run and fail-closed aggregate"
    )
    release_index, release_step = named_step(
        "Require the exact signed Stable release before documentation publication"
    )
    mutate_index, _mutate_step = named_step("Update Stable version history")
    if not ci_index < release_index < mutate_index:
        raise ValueError(
            f"{path}: Stable documentation aliases may move only after exact tag CI "
            "and signed-release publication"
        )

    release_run = str(release_step.get("run", ""))
    release_markers = (
        "actions/workflows/release.yml/runs",
        '.event == "push" and .head_sha == $sha and .head_branch == $tag',
        'if [[ "${status}" != completed ]]',
        'if [[ "${conclusion}" != success ]]',
        '"repos/${GITHUB_REPOSITORY}/releases/tags/${RELEASE_TAG}"',
        ".draft == false",
        ".prerelease == false",
        "(.published_at | type == \"string\" and length > 0)",
        "(.assets | length == 2)",
        '"upgrade-plan.json"',
        '"upgrade-plan.sigstore.json"',
        'all(.assets[]; .state == "uploaded" and .size > 0)',
        "scripts/release_asset_state.py",
        '--commit-sha "${GITHUB_SHA}"',
        '--release-notes "${release_notes}"',
        '.release_state == "published"',
        ".plan_exists == true",
        ".bundle_exists == true",
        ".delete_asset_ids == []",
    )
    for marker in release_markers:
        if marker not in release_run:
            raise ValueError(
                f"{path}: documentation signed Stable release gate lacks {marker!r}"
            )

    release_env = release_step.get("env")
    if not isinstance(release_env, dict) or set(release_env) != {
        "GH_TOKEN",
        "RELEASE_TAG",
    }:
        raise ValueError(f"{path}: documentation signed-release gate environment drifted")

    deploy = jobs.get("deploy")
    environment = deploy.get("environment") if isinstance(deploy, dict) else None
    if not isinstance(environment, dict) or environment.get("name") != "github-pages":
        raise ValueError(f"{path}: documentation deploy must use github-pages environment")
    if deploy.get("needs") != "publish":
        raise ValueError(f"{path}: documentation deploy must require the publisher")


def _step_text(step: dict[str, Any]) -> str:
    """A step's run script plus its environment values (where module lists live)."""
    env = step.get("env")
    values = [str(value) for value in env.values()] if isinstance(env, dict) else []
    return "\n".join([str(step.get("run", "")), *values])


def _assert_postgres_acceptance(path: Path, jobs: dict[str, Any]) -> None:
    """Every PostgreSQL-only module runs against the live service, never skipped."""
    job = jobs.get("postgres-redis")
    if not isinstance(job, dict):
        raise ValueError(f"{path}: PostgreSQL & Redis acceptance job is missing")
    if "postgres" not in (job.get("services") or {}):
        raise ValueError(f"{path}: PostgreSQL acceptance job has no postgres service")
    step = next(
        (
            candidate
            for candidate in job.get("steps", [])
            if isinstance(candidate, dict)
            and candidate.get("name") == POSTGRES_ACCEPTANCE_STEP
        ),
        None,
    )
    if not isinstance(step, dict):
        raise ValueError(f"{path}: PostgreSQL acceptance test step is missing")
    env = step.get("env") if isinstance(step.get("env"), dict) else {}
    if not str(env.get("POSTGRES_TEST_DB_URL", "")).startswith("postgresql"):
        raise ValueError(
            f"{path}: PostgreSQL acceptance tests must export POSTGRES_TEST_DB_URL"
        )
    text = _step_text(step)
    for module in _postgres_acceptance_modules():
        if module not in text:
            raise ValueError(
                f"{path}: PostgreSQL acceptance step does not run {module}"
            )
    for marker in ("--junit-xml", 'counts["skipped"]', "no PostgreSQL acceptance test executed"):
        if marker not in text:
            raise ValueError(
                f"{path}: PostgreSQL acceptance step lacks its executed-not-skipped "
                f"assertion ({marker!r})"
            )


def _assert_rollback_lane(path: Path, jobs: dict[str, Any]) -> None:
    """The N to N-1 rollback lane runs both scenarios on a live PostgreSQL service."""
    job = jobs.get("rollback-lane")
    if not isinstance(job, dict):
        raise ValueError(f"{path}: N to N-1 rollback lane is missing")
    if "postgres" not in (job.get("services") or {}):
        raise ValueError(f"{path}: N to N-1 rollback lane has no postgres service")
    text = _job_run_text(job)
    for marker in (
        "python scripts/rollback_lane.py",
        "--database-url postgresql",
        "python -m unittest scripts.test_rollback_lane",
    ):
        if marker not in text:
            raise ValueError(f"{path}: the N to N-1 rollback lane lacks {marker!r}")
    for flag in ROLLBACK_REHEARSAL_FLAGS:
        if flag in text:
            raise ValueError(
                f"{path}: the N to N-1 rollback lane must not pass {flag} "
                "(it replaces or drops a required scenario)"
            )


def _assert_verdict_stability(path: Path, jobs: dict[str, Any]) -> None:
    """The deterministic verdict stability gate runs as its own lane."""
    job = jobs.get("verdict-stability")
    if not isinstance(job, dict):
        raise ValueError(f"{path}: verdict stability gate is missing")
    text = _job_run_text(job)
    if "python -m pytest" not in text or "tests/test_verdict_stability_gate.py" not in text:
        raise ValueError(
            f"{path}: verdict stability gate does not run "
            "tests/test_verdict_stability_gate.py"
        )
    if "--deselect" in text or " -k " in text:
        raise ValueError(f"{path}: verdict stability gate must run the whole gate file")


def _job_run_text(job: Any) -> str:
    if not isinstance(job, dict):
        return ""
    return "\n".join(
        str(step.get("run", ""))
        for step in job.get("steps", [])
        if isinstance(step, dict)
    )


def _assert_dockerfile_bases(path: Path) -> None:
    stages: set[str] = set()
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        match = re.match(
            r"^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?\s*$",
            line,
            flags=re.IGNORECASE,
        )
        if match is None:
            continue
        image_ref, stage_name = match.groups()
        if image_ref not in stages and not IMAGE_REF.fullmatch(image_ref):
            raise ValueError(
                f"{path}:{line_number}: external base image must use a reviewed digest: "
                f"{image_ref}"
            )
        if stage_name:
            stages.add(stage_name)


def _assert_webui_build_platforms(path: Path) -> None:
    """Keep architecture-neutral Console builds native in multi-platform releases."""

    stages: list[tuple[str | None, str | None]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        match = re.match(
            r"^\s*FROM\s+(?:--platform=(\S+)\s+)?\S+(?:\s+AS\s+(\S+))?\s*$",
            line,
            flags=re.IGNORECASE,
        )
        if match is not None:
            platform, stage_name = match.groups()
            stages.append((stage_name.lower() if stage_name else None, platform))

    stage_platforms = {
        stage_name: platform for stage_name, platform in stages if stage_name is not None
    }
    for stage_name in ("docs", "build"):
        if stage_platforms.get(stage_name) != "$BUILDPLATFORM":
            raise ValueError(
                f"{path}: architecture-neutral {stage_name!r} stage must use "
                "--platform=$BUILDPLATFORM so package tools never run under target "
                "architecture emulation"
            )

    if not stages or stages[-1] != (None, None):
        raise ValueError(
            f"{path}: final Web Console runtime stage must be the unnamed last stage "
            "and inherit Docker's target platform without a --platform override"
        )


def main() -> int:
    paths = _workflow_paths()
    for path in paths:
        workflow = _load(path)
        _assert_common(path, workflow)
        if path.name == "ci.yml":
            _assert_ci(path, workflow)
        elif path.name == "release.yml":
            _assert_release(path, workflow)
        elif path.name == "docs.yml":
            _assert_docs(path, workflow)
    for path in SHIPPING_DOCKERFILES:
        _assert_dockerfile_bases(path)
    _assert_webui_build_platforms(ROOT / "webui" / "Dockerfile")
    print(
        f"CI policy passed for {len(paths)} workflows and "
        f"{len(SHIPPING_DOCKERFILES)} shipping Dockerfiles"
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, TypeError, ValueError, yaml.YAMLError) as exc:
        print(f"CI policy failed: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
