from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock

from scripts import check_ci_contract as policy


PINNED_CHECKOUT = (
    "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803"
)


def _job() -> dict[str, object]:
    return {
        "runs-on": "ubuntu-latest",
        "timeout-minutes": 5,
        "steps": [{"uses": PINNED_CHECKOUT}],
    }


def _ci_workflow() -> dict[str, object]:
    bootstrap_bash32 = _job()
    bootstrap_bash32["runs-on"] = "macos-15"
    bootstrap_bash32["steps"] = [
        {"uses": PINNED_CHECKOUT},
        {
            "run": (
                "/bin/bash -c 'printf ok'\n"
                'test "3.2" = "3.2"\n'
                "/bin/bash -n scripts/bootstrap-updater.sh\n"
                "python3 scripts/test_bootstrap_bash32.py\n"
            )
        },
    ]
    container_images = _job()
    container_images["steps"] = [
        {"uses": PINNED_CHECKOUT},
        {
            "name": "Verify image identity and runtime contract",
            "run": (
                'IMAGE="agentic-soc-ci/backend:${GITHUB_SHA}"\n'
                'docker run --rm --entrypoint python "${IMAGE}" -m pip check\n'
                'docker run --rm --entrypoint python "${IMAGE}" -c '
                "'from importlib.metadata import version; "
                "assert version(\"wheel\") == \"0.45.1\"'\n"
                'jq -e \'.Config.User == "0:10001" and '
                '(.Config.Env | index("TUF_ROOT=/var/lib/agentic-soc-updater/sigstore-root")) '
                "!= null' image.json\n"
            ),
        },
        {
            "name": "Smoke updater control socket without Linux capabilities",
            "if": "${{ matrix.component == 'updater' }}",
            "run": (
                "docker run --detach --read-only --cap-drop ALL "
                "--security-opt no-new-privileges:true image\n"
                "docker inspect --format '{{.State.Health.Status}}' container\n"
                "docker exec container sh -c '"
                'test "${TUF_ROOT}" = /var/lib/agentic-soc-updater/sigstore-root; '
                'test -w "${TUF_ROOT}"'
                "'\n"
                "docker run --rm --user 10001:10001 image python3 -c '"
                "stat.S_ISSOCK(details.st_mode); "
                "details.st_uid == 0; "
                "details.st_gid == 10001; "
                "stat.S_IMODE(details.st_mode) == 0o660; "
                "GET /v1/status HTTP/1.1'\n"
            ),
        },
        {
            "name": "Smoke the shipping Web Console health contract",
            "if": "${{ matrix.component == 'webui' }}",
            "run": (
                "docker run --detach --health-interval 1s image\n"
                "docker inspect --format '{{.State.Health.Status}}' container\n"
                "curl --fail http://127.0.0.1/\n"
            ),
        },
    ]
    postgres_service = {"image": "pgvector/pgvector:pg16@sha256:" + "a" * 64}
    postgres_redis = _job()
    postgres_redis["services"] = {"postgres": dict(postgres_service)}
    postgres_redis["steps"] = [
        {"uses": PINNED_CHECKOUT},
        {
            "name": policy.POSTGRES_ACCEPTANCE_STEP,
            "env": {
                "POSTGRES_TEST_DB_URL": "postgresql+asyncpg://ci@127.0.0.1:5432/ci",
                "ACCEPTANCE_MODULES": " ".join(policy._postgres_acceptance_modules()),
            },
            "run": (
                'python -m pytest -q -rs "${modules[@]}" --junit-xml=report.xml\n'
                'if counts["skipped"]: raise SystemExit("skipped")\n'
                'raise SystemExit(f"no PostgreSQL acceptance test executed from {m}")\n'
            ),
        },
    ]
    rollback_lane = _job()
    rollback_lane["services"] = {"postgres": dict(postgres_service)}
    rollback_lane["steps"] = [
        {"uses": PINNED_CHECKOUT},
        {"run": "python -m unittest scripts.test_rollback_lane -v"},
        {
            "run": (
                "python scripts/rollback_lane.py \\\n"
                "  --database-url postgresql+asyncpg://ci@127.0.0.1:5432/ci \\\n"
                '  --work-dir "${RUNNER_TEMP}/rollback-lane"\n'
            )
        },
    ]
    verdict_stability = _job()
    verdict_stability["steps"] = [
        {"uses": PINNED_CHECKOUT},
        {"run": "python -m pytest -q -rs tests/test_verdict_stability_gate.py"},
    ]
    gated = [
        "quality",
        "bootstrap-bash32",
        "container-images",
        "postgres-redis",
        "rollback-lane",
        "verdict-stability",
    ]
    return {
        "on": {"pull_request": {}, "push": {}},
        "permissions": {"contents": "read"},
        "jobs": {
            "quality": _job(),
            "bootstrap-bash32": bootstrap_bash32,
            "container-images": container_images,
            "postgres-redis": postgres_redis,
            "rollback-lane": rollback_lane,
            "verdict-stability": verdict_stability,
            "ci": {
                "name": "CI passed",
                "runs-on": "ubuntu-latest",
                "timeout-minutes": 5,
                "if": "${{ always() }}",
                "needs": list(gated),
                "steps": [
                    {
                        "run": "\n".join(
                            [
                                *(
                                    f'r{index}="${{{{ needs.{job_id}.result }}}}"'
                                    for index, job_id in enumerate(gated)
                                ),
                                *(
                                    f'[[ "$r{index}" == "success" ]]'
                                    for index, _ in enumerate(gated)
                                ),
                            ]
                        )
                    }
                ],
            },
        },
    }


def _aggregate_echo_only(workflow: dict[str, object]) -> list[dict[str, str]]:
    """Aggregate steps that inspect every result but never require success."""
    needs = workflow["jobs"]["ci"]["needs"]  # type: ignore[index]
    return [
        {"run": "\n".join(f'echo "${{{{ needs.{job_id}.result }}}}"' for job_id in needs)}
    ]


class WorkflowPolicyTests(unittest.TestCase):
    def test_known_good_ci_contract_passes(self) -> None:
        workflow = _ci_workflow()
        policy._assert_common(Path("ci.yml"), workflow)
        policy._assert_ci(Path("ci.yml"), workflow)

    def test_duplicate_yaml_key_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "duplicate.yml"
            path.write_text("name: first\nname: second\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "duplicate key"):
                policy._load(path)

    def test_yaml_extension_cannot_bypass_the_workflow_allowlist(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in policy.EXPECTED_WORKFLOWS:
                (root / name).touch()
            (root / "escape.yaml").touch()
            with mock.patch.object(policy, "WORKFLOW_DIR", root):
                with self.assertRaisesRegex(ValueError, "unknown=\\['escape.yaml'\\]"):
                    policy._workflow_paths()

    def test_required_workflow_cannot_be_removed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "ci.yml").touch()
            (root / "docs.yml").touch()
            with mock.patch.object(policy, "WORKFLOW_DIR", root):
                with self.assertRaisesRegex(ValueError, "missing=\\['release.yml'\\]"):
                    policy._workflow_paths()

    def test_mutable_action_reference_is_rejected(self) -> None:
        workflow = _ci_workflow()
        workflow["jobs"]["quality"]["steps"] = [  # type: ignore[index]
            {"uses": "actions/checkout@v6"}
        ]
        with self.assertRaisesRegex(ValueError, "40-char SHA"):
            policy._assert_common(Path("ci.yml"), workflow)

    def test_mutable_service_image_is_rejected(self) -> None:
        workflow = _ci_workflow()
        workflow["jobs"]["quality"]["services"] = {  # type: ignore[index]
            "postgres": {"image": "pgvector/pgvector:pg16"}
        }
        with self.assertRaisesRegex(ValueError, "must use an image digest"):
            policy._assert_ci(Path("ci.yml"), workflow)

    def test_digest_pinned_service_image_passes(self) -> None:
        workflow = _ci_workflow()
        workflow["jobs"]["quality"]["services"] = {  # type: ignore[index]
            "postgres": {"image": "pgvector/pgvector@sha256:" + "a" * 64}
        }
        policy._assert_ci(Path("ci.yml"), workflow)

    def test_continue_on_error_is_rejected(self) -> None:
        workflow = _ci_workflow()
        workflow["jobs"]["quality"]["continue-on-error"] = True  # type: ignore[index]
        with self.assertRaisesRegex(ValueError, "continue-on-error"):
            policy._assert_common(Path("ci.yml"), workflow)

    def test_missing_timeout_is_rejected(self) -> None:
        workflow = _ci_workflow()
        del workflow["jobs"]["quality"]["timeout-minutes"]  # type: ignore[index]
        with self.assertRaisesRegex(ValueError, "no timeout-minutes"):
            policy._assert_common(Path("ci.yml"), workflow)

    def test_pull_request_target_is_rejected(self) -> None:
        workflow = _ci_workflow()
        workflow["on"] = {"pull_request_target": {}, "push": {}}
        with self.assertRaisesRegex(ValueError, "unsafe or malformed"):
            policy._assert_ci(Path("ci.yml"), workflow)

    def test_new_job_must_enter_aggregate(self) -> None:
        workflow = _ci_workflow()
        workflow["jobs"]["untracked"] = _job()  # type: ignore[index]
        with self.assertRaisesRegex(ValueError, "dependency drift"):
            policy._assert_ci(Path("ci.yml"), workflow)

    def test_bootstrap_bash32_job_is_required(self) -> None:
        workflow = _ci_workflow()
        del workflow["jobs"]["bootstrap-bash32"]  # type: ignore[index]
        workflow["jobs"]["ci"]["needs"].remove("bootstrap-bash32")  # type: ignore[index]
        with self.assertRaisesRegex(ValueError, "Bash 3.2 bootstrap gate is missing"):
            policy._assert_ci(Path("ci.yml"), workflow)

    def test_bootstrap_bash32_job_must_use_macos15(self) -> None:
        workflow = _ci_workflow()
        workflow["jobs"]["bootstrap-bash32"]["runs-on"] = "ubuntu-latest"  # type: ignore[index]
        with self.assertRaisesRegex(ValueError, "must run on macos-15"):
            policy._assert_ci(Path("ci.yml"), workflow)

    def test_bootstrap_bash32_job_must_execute_shipping_harness(self) -> None:
        workflow = _ci_workflow()
        workflow["jobs"]["bootstrap-bash32"]["steps"][1]["run"] = (  # type: ignore[index]
            "/bin/bash -c 'printf ok'\n"
            'test "3.2" = "3.2"\n'
            "/bin/bash -n scripts/bootstrap-updater.sh\n"
        )
        with self.assertRaisesRegex(ValueError, "test_bootstrap_bash32.py"):
            policy._assert_ci(Path("ci.yml"), workflow)

    def test_aggregate_must_explicitly_require_success(self) -> None:
        workflow = _ci_workflow()
        workflow["jobs"]["ci"]["steps"] = _aggregate_echo_only(workflow)  # type: ignore[index]
        with self.assertRaisesRegex(ValueError, "explicit success"):
            policy._assert_ci(Path("ci.yml"), workflow)

    def test_every_postgres_only_module_is_discovered(self) -> None:
        modules = policy._postgres_acceptance_modules()
        for expected in (
            "tests/test_postgres_state_acceptance.py",
            "tests/test_postgres_json_nul.py",
            "tests/test_postgres_rollback_compat.py",
            "tests/test_postgres_runbook_fallback.py",
        ):
            self.assertIn(expected, modules)

    def test_postgres_acceptance_must_run_every_postgres_module(self) -> None:
        workflow = _ci_workflow()
        step = workflow["jobs"]["postgres-redis"]["steps"][1]  # type: ignore[index]
        step["env"]["ACCEPTANCE_MODULES"] = "tests/test_postgres_state_acceptance.py"
        with self.assertRaisesRegex(ValueError, "does not run tests/test_postgres_"):
            policy._assert_ci(Path("ci.yml"), workflow)

    def test_postgres_acceptance_cannot_drop_its_skip_assertion(self) -> None:
        workflow = _ci_workflow()
        step = workflow["jobs"]["postgres-redis"]["steps"][1]  # type: ignore[index]
        step["run"] = step["run"].replace('counts["skipped"]', "counts")
        with self.assertRaisesRegex(ValueError, "executed-not-skipped"):
            policy._assert_ci(Path("ci.yml"), workflow)

    def test_postgres_acceptance_must_name_a_live_server(self) -> None:
        workflow = _ci_workflow()
        step = workflow["jobs"]["postgres-redis"]["steps"][1]  # type: ignore[index]
        del step["env"]["POSTGRES_TEST_DB_URL"]
        with self.assertRaisesRegex(ValueError, "POSTGRES_TEST_DB_URL"):
            policy._assert_ci(Path("ci.yml"), workflow)

    def test_rollback_lane_is_required(self) -> None:
        workflow = _ci_workflow()
        del workflow["jobs"]["rollback-lane"]  # type: ignore[index]
        workflow["jobs"]["ci"]["needs"].remove("rollback-lane")  # type: ignore[index]
        with self.assertRaisesRegex(ValueError, "rollback lane is missing"):
            policy._assert_ci(Path("ci.yml"), workflow)

    def test_rollback_lane_needs_a_postgres_service(self) -> None:
        workflow = _ci_workflow()
        del workflow["jobs"]["rollback-lane"]["services"]  # type: ignore[index]
        with self.assertRaisesRegex(ValueError, "rollback lane has no postgres service"):
            policy._assert_ci(Path("ci.yml"), workflow)

    def test_rollback_lane_must_run_its_unit_tests(self) -> None:
        workflow = _ci_workflow()
        steps = workflow["jobs"]["rollback-lane"]["steps"]  # type: ignore[index]
        del steps[1]
        with self.assertRaisesRegex(ValueError, "scripts.test_rollback_lane"):
            policy._assert_ci(Path("ci.yml"), workflow)

    def test_rollback_lane_cannot_drop_a_scenario(self) -> None:
        for flag in policy.ROLLBACK_REHEARSAL_FLAGS:
            with self.subTest(flag=flag):
                workflow = _ci_workflow()
                step = workflow["jobs"]["rollback-lane"]["steps"][2]  # type: ignore[index]
                step["run"] = step["run"].rstrip("\n") + f" {flag}\n"
                with self.assertRaisesRegex(ValueError, "must not pass"):
                    policy._assert_ci(Path("ci.yml"), workflow)

    def test_verdict_stability_gate_is_required(self) -> None:
        workflow = _ci_workflow()
        del workflow["jobs"]["verdict-stability"]  # type: ignore[index]
        workflow["jobs"]["ci"]["needs"].remove("verdict-stability")  # type: ignore[index]
        with self.assertRaisesRegex(ValueError, "verdict stability gate is missing"):
            policy._assert_ci(Path("ci.yml"), workflow)

    def test_verdict_stability_gate_must_run_the_gate_file(self) -> None:
        workflow = _ci_workflow()
        workflow["jobs"]["verdict-stability"]["steps"][1]["run"] = (  # type: ignore[index]
            "python -m pytest -q tests/test_runbook_prompt.py"
        )
        with self.assertRaisesRegex(ValueError, "does not run tests/test_verdict_stability_gate"):
            policy._assert_ci(Path("ci.yml"), workflow)

    def test_verdict_stability_gate_cannot_be_narrowed(self) -> None:
        workflow = _ci_workflow()
        workflow["jobs"]["verdict-stability"]["steps"][1]["run"] = (  # type: ignore[index]
            "python -m pytest -q tests/test_verdict_stability_gate.py -k arithmetic"
        )
        with self.assertRaisesRegex(ValueError, "whole gate file"):
            policy._assert_ci(Path("ci.yml"), workflow)

    def test_the_new_lanes_must_enter_the_aggregate(self) -> None:
        for job_id in ("rollback-lane", "verdict-stability"):
            with self.subTest(job=job_id):
                workflow = _ci_workflow()
                workflow["jobs"]["ci"]["needs"].remove(job_id)  # type: ignore[index]
                with self.assertRaisesRegex(ValueError, "dependency drift"):
                    policy._assert_ci(Path("ci.yml"), workflow)

    def test_the_real_ci_workflow_passes(self) -> None:
        ci_path = policy.WORKFLOW_DIR / "ci.yml"
        workflow = policy._load(ci_path)
        policy._assert_common(ci_path, workflow)
        policy._assert_ci(ci_path, workflow)

    def test_shipping_webui_runtime_smoke_cannot_be_removed(self) -> None:
        workflow = _ci_workflow()
        workflow["jobs"]["container-images"]["steps"] = [  # type: ignore[index]
            {"uses": PINNED_CHECKOUT}
        ]
        with self.assertRaisesRegex(ValueError, "health smoke"):
            policy._assert_ci(Path("ci.yml"), workflow)

    def test_shipping_backend_dependency_check_cannot_be_removed(self) -> None:
        workflow = _ci_workflow()
        identity = next(
            step
            for step in workflow["jobs"]["container-images"]["steps"]
            if step.get("name") == "Verify image identity and runtime contract"
        )
        identity["run"] = identity["run"].replace(
            'docker run --rm --entrypoint python "${IMAGE}" -m pip check',
            'echo "dependency check omitted"',
        )
        with self.assertRaisesRegex(ValueError, "installed dependency contract"):
            policy._assert_ci(Path("ci.yml"), workflow)

    def test_shipping_backend_wheel_pin_cannot_drift(self) -> None:
        workflow = _ci_workflow()
        identity = next(
            step
            for step in workflow["jobs"]["container-images"]["steps"]
            if step.get("name") == "Verify image identity and runtime contract"
        )
        identity["run"] = identity["run"].replace(
            'version("wheel") == "0.45.1"',
            'version("wheel") != ""',
        )
        with self.assertRaisesRegex(ValueError, "reviewed Wheel version"):
            policy._assert_ci(Path("ci.yml"), workflow)

    def test_shipping_updater_primary_group_cannot_drift(self) -> None:
        workflow = _ci_workflow()
        identity = next(
            step
            for step in workflow["jobs"]["container-images"]["steps"]
            if step.get("name") == "Verify image identity and runtime contract"
        )
        identity["run"] = identity["run"].replace(
            '.Config.User == "0:10001"',
            '.Config.User == ""',
        )
        with self.assertRaisesRegex(ValueError, "control-socket GID"):
            policy._assert_ci(Path("ci.yml"), workflow)

    def test_shipping_updater_sigstore_cache_cannot_leave_state_volume(self) -> None:
        workflow = _ci_workflow()
        identity = next(
            step
            for step in workflow["jobs"]["container-images"]["steps"]
            if step.get("name") == "Verify image identity and runtime contract"
        )
        identity["run"] = identity["run"].replace(
            "TUF_ROOT=/var/lib/agentic-soc-updater/sigstore-root",
            "TUF_ROOT=/root/.sigstore/root",
        )
        with self.assertRaisesRegex(ValueError, "Sigstore trust state"):
            policy._assert_ci(Path("ci.yml"), workflow)

    def test_shipping_updater_socket_runtime_smoke_cannot_be_removed(self) -> None:
        workflow = _ci_workflow()
        workflow["jobs"]["container-images"]["steps"] = [
            step
            for step in workflow["jobs"]["container-images"]["steps"]
            if step.get("name")
            != "Smoke updater control socket without Linux capabilities"
        ]
        with self.assertRaisesRegex(ValueError, "control-socket runtime smoke"):
            policy._assert_ci(Path("ci.yml"), workflow)

    def test_repository_publishers_require_exact_tag_ci(self) -> None:
        docs_path = policy.WORKFLOW_DIR / "docs.yml"
        release_path = policy.WORKFLOW_DIR / "release.yml"
        policy._assert_docs(docs_path, policy._load(docs_path))
        policy._assert_release(release_path, policy._load(release_path))

    def test_release_builds_cannot_publish_stable_tags_early(self) -> None:
        release_path = policy.WORKFLOW_DIR / "release.yml"
        workflow = policy._load(release_path)
        build = next(
            step
            for step in workflow["jobs"]["publish"]["steps"]
            if step.get("name") == "Build and publish backend by immutable digest"
        )
        build["with"]["tags"] = (
            "${{ steps.release.outputs.image_prefix }}/backend:"
            "${{ steps.release.outputs.tag }}"
        )
        with self.assertRaisesRegex(ValueError, "non-Stable candidate tag"):
            policy._assert_release(release_path, workflow)

    def test_release_anonymous_pull_gate_requires_fresh_docker_config(self) -> None:
        release_path = policy.WORKFLOW_DIR / "release.yml"
        workflow = policy._load(release_path)
        gate = next(
            step
            for step in workflow["jobs"]["publish"]["steps"]
            if step.get("name")
            == "Prove anonymous pullability and exact OCI release labels"
        )
        gate["run"] = gate["run"].replace(
            'export DOCKER_CONFIG="${anonymous_docker_config}"',
            'export DOCKER_CONFIG="${HOME}/.docker"',
        )
        with self.assertRaisesRegex(ValueError, "isolated multi-platform"):
            policy._assert_release(release_path, workflow)

    def test_release_anonymous_pull_gate_requires_both_platforms(self) -> None:
        release_path = policy.WORKFLOW_DIR / "release.yml"
        workflow = policy._load(release_path)
        gate = next(
            step
            for step in workflow["jobs"]["publish"]["steps"]
            if step.get("name")
            == "Prove anonymous pullability and exact OCI release labels"
        )
        gate["run"] = gate["run"].replace(
            'EXPECTED_PLATFORMS = {("linux", "amd64"), ("linux", "arm64")}',
            'EXPECTED_PLATFORMS = {("linux", "amd64")}',
        )
        with self.assertRaisesRegex(ValueError, "isolated multi-platform"):
            policy._assert_release(release_path, workflow)

    def test_release_anonymous_pull_gate_requires_exact_reference_eviction(
        self,
    ) -> None:
        release_path = policy.WORKFLOW_DIR / "release.yml"
        workflow = policy._load(release_path)
        gate = next(
            step
            for step in workflow["jobs"]["publish"]["steps"]
            if step.get("name")
            == "Prove anonymous pullability and exact OCI release labels"
        )
        gate["run"] = gate["run"].replace(
            'docker image rm "${reference}"',
            'echo "local image retained"',
        )
        with self.assertRaisesRegex(ValueError, "isolated multi-platform"):
            policy._assert_release(release_path, workflow)

    def test_release_anonymous_pull_gate_rejects_publisher_credentials(self) -> None:
        release_path = policy.WORKFLOW_DIR / "release.yml"
        workflow = policy._load(release_path)
        gate = next(
            step
            for step in workflow["jobs"]["publish"]["steps"]
            if step.get("name")
            == "Prove anonymous pullability and exact OCI release labels"
        )
        gate["env"]["GH_TOKEN"] = "${{ github.token }}"
        with self.assertRaisesRegex(ValueError, "may not receive publisher credentials"):
            policy._assert_release(release_path, workflow)

    def test_release_inspection_cannot_use_jq_truthiness_for_false(self) -> None:
        release_path = policy.WORKFLOW_DIR / "release.yml"
        workflow = policy._load(release_path)
        inspection = next(
            step
            for step in workflow["jobs"]["publish"]["steps"]
            if step.get("name")
            == "Inspect and safely recover an exact draft release"
        )
        inspection["run"] += (
            '\nrelease_exists="$(jq -er \'.release_exists\' <<<"${state}")"\n'
        )
        with self.assertRaisesRegex(ValueError, "valid false must not abort"):
            policy._assert_release(release_path, workflow)

    def test_release_publication_requires_typed_boolean_reads(self) -> None:
        release_path = policy.WORKFLOW_DIR / "release.yml"
        workflow = policy._load(release_path)
        publication = next(
            step
            for step in workflow["jobs"]["publish"]["steps"]
            if step.get("name")
            == "Stage, verify, and atomically publish the GitHub Release"
        )
        publication["run"] = publication["run"].replace(
            "--field bundle_exists",
            "--field removed_bundle_exists",
        )
        with self.assertRaisesRegex(ValueError, "typed release-state boolean parser"):
            policy._assert_release(release_path, workflow)

    def test_release_requires_signed_plan_verification_in_shipping_updater(self) -> None:
        release_path = policy.WORKFLOW_DIR / "release.yml"
        workflow = policy._load(release_path)
        workflow["jobs"]["publish"]["steps"] = [
            step
            for step in workflow["jobs"]["publish"]["steps"]
            if step.get("name")
            != "Verify the signed plan inside the constrained update supervisor"
        ]
        with self.assertRaisesRegex(ValueError, "constrained update supervisor"):
            policy._assert_release(release_path, workflow)

    def test_release_signed_plan_gate_must_start_the_real_supervisor(self) -> None:
        release_path = policy.WORKFLOW_DIR / "release.yml"
        workflow = policy._load(release_path)
        gate = next(
            step
            for step in workflow["jobs"]["publish"]["steps"]
            if step.get("name")
            == "Verify the signed plan inside the constrained update supervisor"
        )
        gate["run"] = gate["run"].replace(
            "docker run --detach",
            "docker run --rm --entrypoint sh",
        ).replace(
            "docker exec \\",
            "docker run --rm --entrypoint sh \\",
        )
        with self.assertRaisesRegex(ValueError, "constrained updater"):
            policy._assert_release(release_path, workflow)

    def test_release_signed_plan_gate_cannot_be_skipped(self) -> None:
        release_path = policy.WORKFLOW_DIR / "release.yml"
        workflow = policy._load(release_path)
        gate = next(
            step
            for step in workflow["jobs"]["publish"]["steps"]
            if step.get("name")
            == "Verify the signed plan inside the constrained update supervisor"
        )
        gate["if"] = "${{ false }}"
        with self.assertRaisesRegex(ValueError, "unconditional fail-closed"):
            policy._assert_release(release_path, workflow)

    def test_release_signed_plan_gate_cannot_continue_on_error(self) -> None:
        release_path = policy.WORKFLOW_DIR / "release.yml"
        workflow = policy._load(release_path)
        gate = next(
            step
            for step in workflow["jobs"]["publish"]["steps"]
            if step.get("name")
            == "Verify the signed plan inside the constrained update supervisor"
        )
        gate["continue-on-error"] = True
        with self.assertRaisesRegex(ValueError, "unconditional fail-closed"):
            policy._assert_release(release_path, workflow)

    def test_release_signed_plan_gate_normalizes_bind_mount_permissions(self) -> None:
        release_path = policy.WORKFLOW_DIR / "release.yml"
        workflow = policy._load(release_path)
        gate = next(
            step
            for step in workflow["jobs"]["publish"]["steps"]
            if step.get("name")
            == "Verify the signed plan inside the constrained update supervisor"
        )
        gate["run"] = gate["run"].replace(
            'chmod 0555 "${verification_dir}"',
            ': # permission normalization removed',
        )
        with self.assertRaisesRegex(ValueError, "constrained updater"):
            policy._assert_release(release_path, workflow)

    def test_release_signed_plan_gate_restores_owner_write_for_cleanup(self) -> None:
        release_path = policy.WORKFLOW_DIR / "release.yml"
        workflow = policy._load(release_path)
        gate = next(
            step
            for step in workflow["jobs"]["publish"]["steps"]
            if step.get("name")
            == "Verify the signed plan inside the constrained update supervisor"
        )
        gate["run"] = gate["run"].replace(
            'chmod 0700 "${verification_dir}"',
            ': # cleanup permission restoration removed',
        )
        with self.assertRaisesRegex(ValueError, "cleanup must restore"):
            policy._assert_release(release_path, workflow)

    def test_release_signed_plan_gate_restores_cleanup_permission_before_remove(self) -> None:
        release_path = policy.WORKFLOW_DIR / "release.yml"
        workflow = policy._load(release_path)
        gate = next(
            step
            for step in workflow["jobs"]["publish"]["steps"]
            if step.get("name")
            == "Verify the signed plan inside the constrained update supervisor"
        )
        restore = 'chmod 0700 "${verification_dir}"'
        remove = 'rm -rf -- "${verification_dir}"'
        run = gate["run"]
        restore_index = run.index(restore)
        remove_index = run.index(remove)
        gate["run"] = (
            run[:restore_index]
            + remove
            + run[restore_index + len(restore) : remove_index]
            + restore
            + run[remove_index + len(remove) :]
        )
        with self.assertRaisesRegex(ValueError, "preserve the original result"):
            policy._assert_release(release_path, workflow)

    def test_release_signed_plan_gate_guards_cleanup_directory(self) -> None:
        release_path = policy.WORKFLOW_DIR / "release.yml"
        workflow = policy._load(release_path)
        gate = next(
            step
            for step in workflow["jobs"]["publish"]["steps"]
            if step.get("name")
            == "Verify the signed plan inside the constrained update supervisor"
        )
        gate["run"] = gate["run"].replace(
            'if [[ -d "${verification_dir}" ]]; then',
            ': # cleanup guard removed',
        )
        with self.assertRaisesRegex(ValueError, "cleanup must guard"):
            policy._assert_release(release_path, workflow)

    def test_release_signed_plan_gate_cleanup_preserves_original_status(self) -> None:
        release_path = policy.WORKFLOW_DIR / "release.yml"
        workflow = policy._load(release_path)
        gate = next(
            step
            for step in workflow["jobs"]["publish"]["steps"]
            if step.get("name")
            == "Verify the signed plan inside the constrained update supervisor"
        )
        gate["run"] = gate["run"].replace(
            "release_step_status=$?",
            "release_step_status=0",
            1,
        )
        with self.assertRaisesRegex(ValueError, "preserve the release result"):
            policy._assert_release(release_path, workflow)

    def test_release_signed_plan_gate_proves_container_absent_before_cleanup(self) -> None:
        release_path = policy.WORKFLOW_DIR / "release.yml"
        workflow = policy._load(release_path)
        gate = next(
            step
            for step in workflow["jobs"]["publish"]["steps"]
            if step.get("name")
            == "Verify the signed plan inside the constrained update supervisor"
        )
        gate["run"] = gate["run"].replace(
            "docker container ls --all",
            ": # container-absence probe removed",
            1,
        )
        with self.assertRaisesRegex(ValueError, "preserve the release result"):
            policy._assert_release(release_path, workflow)

    def test_release_signed_plan_gate_uses_exact_container_name_probe(self) -> None:
        release_path = policy.WORKFLOW_DIR / "release.yml"
        workflow = policy._load(release_path)
        gate = next(
            step
            for step in workflow["jobs"]["publish"]["steps"]
            if step.get("name")
            == "Verify the signed plan inside the constrained update supervisor"
        )
        gate["run"] = gate["run"].replace(
            '--filter "name=^/${container}$"',
            '--filter "name=${container}"',
            1,
        )
        with self.assertRaisesRegex(ValueError, "preserve the release result"):
            policy._assert_release(release_path, workflow)

    def test_release_signed_plan_gate_defers_fixture_cleanup_until_bind_is_gone(self) -> None:
        release_path = policy.WORKFLOW_DIR / "release.yml"
        workflow = policy._load(release_path)
        gate = next(
            step
            for step in workflow["jobs"]["publish"]["steps"]
            if step.get("name")
            == "Verify the signed plan inside the constrained update supervisor"
        )
        gate["run"] = gate["run"].replace(
            "if (( verification_cleanup_status == 0 )); then",
            "if true; then",
            1,
        )
        with self.assertRaisesRegex(ValueError, "preserve the release result"):
            policy._assert_release(release_path, workflow)

    def test_release_signed_plan_gate_does_not_restore_fixture_before_absence_probe(self) -> None:
        release_path = policy.WORKFLOW_DIR / "release.yml"
        workflow = policy._load(release_path)
        gate = next(
            step
            for step in workflow["jobs"]["publish"]["steps"]
            if step.get("name")
            == "Verify the signed plan inside the constrained update supervisor"
        )
        restore = 'chmod 0700 "${verification_dir}"'
        probe = "docker container ls --all"
        run = gate["run"]
        run = run.replace(restore, "", 1)
        insertion = run.index(probe)
        gate["run"] = run[:insertion] + restore + "\n            " + run[insertion:]
        with self.assertRaisesRegex(ValueError, "preserve the original result"):
            policy._assert_release(release_path, workflow)

    def test_release_signed_plan_gate_registers_cleanup_before_fixture_setup(self) -> None:
        release_path = policy.WORKFLOW_DIR / "release.yml"
        workflow = policy._load(release_path)
        gate = next(
            step
            for step in workflow["jobs"]["publish"]["steps"]
            if step.get("name")
            == "Verify the signed plan inside the constrained update supervisor"
        )
        run = gate["run"]
        registration = "trap cleanup EXIT\n"
        run = run.replace(registration, "", 1)
        insertion = run.index('chmod 0555 "${verification_dir}"')
        insertion = run.index("\n", insertion) + 1
        gate["run"] = run[:insertion] + registration + run[insertion:]
        with self.assertRaisesRegex(ValueError, "register cleanup"):
            policy._assert_release(release_path, workflow)

    def test_release_signed_plan_gate_requires_exact_bind_asset_destination(self) -> None:
        release_path = policy.WORKFLOW_DIR / "release.yml"
        workflow = policy._load(release_path)
        gate = next(
            step
            for step in workflow["jobs"]["publish"]["steps"]
            if step.get("name")
            == "Verify the signed plan inside the constrained update supervisor"
        )
        gate["run"] = gate["run"].replace(
            '"${verification_dir}/upgrade-plan.sigstore.json"',
            '"${verification_dir}/bundle.json"',
            1,
        )
        with self.assertRaisesRegex(ValueError, "constrained updater"):
            policy._assert_release(release_path, workflow)

    def test_release_signed_plan_gate_normalizes_before_container_start(self) -> None:
        release_path = policy.WORKFLOW_DIR / "release.yml"
        workflow = policy._load(release_path)
        gate = next(
            step
            for step in workflow["jobs"]["publish"]["steps"]
            if step.get("name")
            == "Verify the signed plan inside the constrained update supervisor"
        )
        gate["run"] = gate["run"].replace(
            'chmod 0555 "${verification_dir}"\n',
            "",
            1,
        ).replace(
            "docker run --detach \\\n",
            "docker run --detach \\\n"
            'chmod 0555 "${verification_dir}"\n',
            1,
        )
        with self.assertRaisesRegex(ValueError, "must order"):
            policy._assert_release(release_path, workflow)

    def test_release_signed_plan_gate_rejects_broad_permission_changes(self) -> None:
        release_path = policy.WORKFLOW_DIR / "release.yml"
        broad_mutations = (
            'chmod 0777 "${verification_dir}"',
            'chmod -R a+rX "${verification_dir}"',
            'chown 0:10001 "${verification_dir}"',
            'cp upgrade-plan.json upgrade-plan.sigstore.json "${verification_dir}/"',
        )
        for mutation in broad_mutations:
            with self.subTest(mutation=mutation):
                workflow = policy._load(release_path)
                gate = next(
                    step
                    for step in workflow["jobs"]["publish"]["steps"]
                    if step.get("name")
                    == "Verify the signed plan inside the constrained update supervisor"
                )
                gate["run"] = gate["run"].replace(
                    'chmod 0555 "${verification_dir}"',
                    f'chmod 0555 "${{verification_dir}}"\n          {mutation}',
                    1,
                )
                with self.assertRaisesRegex(ValueError, "forbidden runtime override"):
                    policy._assert_release(release_path, workflow)

    def test_release_stable_tags_must_follow_release_publication(self) -> None:
        release_path = policy.WORKFLOW_DIR / "release.yml"
        workflow = policy._load(release_path)
        steps = workflow["jobs"]["publish"]["steps"]
        stable = next(
            step
            for step in steps
            if step.get("name")
            == "Publish Stable convenience tags after release publication"
        )
        steps.remove(stable)
        publish_index = next(
            index
            for index, step in enumerate(steps)
            if step.get("name")
            == "Stage, verify, and atomically publish the GitHub Release"
        )
        steps.insert(publish_index, stable)
        with self.assertRaisesRegex(ValueError, "publish before images"):
            policy._assert_release(release_path, workflow)

    def test_release_workflow_cannot_depend_on_documentation(self) -> None:
        release_path = policy.WORKFLOW_DIR / "release.yml"
        workflow = policy._load(release_path)
        trigger = workflow.get("on", workflow.get(True))
        trigger["workflow_run"] = {"workflows": ["Documentation"]}
        with self.assertRaisesRegex(ValueError, "may not depend on documentation"):
            policy._assert_release(release_path, workflow)

    def test_docs_publisher_cannot_drop_exact_tag_ci_gate(self) -> None:
        docs_path = policy.WORKFLOW_DIR / "docs.yml"
        workflow = policy._load(docs_path)
        publish = workflow["jobs"]["publish"]
        publish["steps"] = [
            step
            for step in publish["steps"]
            if step.get("name")
            != "Require the exact tag CI run and fail-closed aggregate"
        ]
        with self.assertRaisesRegex(ValueError, "exact tag CI"):
            policy._assert_docs(docs_path, workflow)

    def test_docs_publisher_requires_actions_read_permission(self) -> None:
        docs_path = policy.WORKFLOW_DIR / "docs.yml"
        workflow = policy._load(docs_path)
        workflow["jobs"]["publish"]["permissions"] = {"contents": "write"}
        with self.assertRaisesRegex(ValueError, "publisher permissions drifted"):
            policy._assert_docs(docs_path, workflow)

    def test_docs_publisher_cannot_drop_signed_release_gate(self) -> None:
        docs_path = policy.WORKFLOW_DIR / "docs.yml"
        workflow = policy._load(docs_path)
        publish = workflow["jobs"]["publish"]
        publish["steps"] = [
            step
            for step in publish["steps"]
            if step.get("name")
            != "Require the exact signed Stable release before documentation publication"
        ]
        with self.assertRaisesRegex(ValueError, "signed Stable release"):
            policy._assert_docs(docs_path, workflow)

    def test_docs_publisher_rejects_prerelease_gate_drift(self) -> None:
        docs_path = policy.WORKFLOW_DIR / "docs.yml"
        workflow = policy._load(docs_path)
        gate = next(
            step
            for step in workflow["jobs"]["publish"]["steps"]
            if step.get("name")
            == "Require the exact signed Stable release before documentation publication"
        )
        gate["run"] = gate["run"].replace(
            ".prerelease == false",
            ".prerelease == true",
        )
        with self.assertRaisesRegex(ValueError, "prerelease"):
            policy._assert_docs(docs_path, workflow)

    def test_docs_publisher_requires_successful_release_workflow(self) -> None:
        docs_path = policy.WORKFLOW_DIR / "docs.yml"
        workflow = policy._load(docs_path)
        gate = next(
            step
            for step in workflow["jobs"]["publish"]["steps"]
            if step.get("name")
            == "Require the exact signed Stable release before documentation publication"
        )
        gate["run"] = gate["run"].replace(
            'if [[ "${conclusion}" != success ]]',
            'if [[ "${conclusion}" == success ]]',
        )
        with self.assertRaisesRegex(ValueError, "conclusion"):
            policy._assert_docs(docs_path, workflow)

    def test_docs_publisher_requires_exact_release_asset_inventory(self) -> None:
        docs_path = policy.WORKFLOW_DIR / "docs.yml"
        workflow = policy._load(docs_path)
        gate = next(
            step
            for step in workflow["jobs"]["publish"]["steps"]
            if step.get("name")
            == "Require the exact signed Stable release before documentation publication"
        )
        gate["run"] = gate["run"].replace(
            '"upgrade-plan.sigstore.json"',
            '"upgrade-plan.sigstore.txt"',
        )
        with self.assertRaisesRegex(ValueError, "upgrade-plan.sigstore.json"):
            policy._assert_docs(docs_path, workflow)

    def test_docs_publisher_requires_canonical_release_identity_classifier(self) -> None:
        docs_path = policy.WORKFLOW_DIR / "docs.yml"
        workflow = policy._load(docs_path)
        gate = next(
            step
            for step in workflow["jobs"]["publish"]["steps"]
            if step.get("name")
            == "Require the exact signed Stable release before documentation publication"
        )
        gate["run"] = gate["run"].replace(
            "scripts/release_asset_state.py",
            "scripts/unsafe_release_identity.py",
        )
        with self.assertRaisesRegex(ValueError, "release_asset_state.py"):
            policy._assert_docs(docs_path, workflow)

    def test_docs_signed_release_gate_must_precede_alias_mutation(self) -> None:
        docs_path = policy.WORKFLOW_DIR / "docs.yml"
        workflow = policy._load(docs_path)
        steps = workflow["jobs"]["publish"]["steps"]
        gate = next(
            step
            for step in steps
            if step.get("name")
            == "Require the exact signed Stable release before documentation publication"
        )
        steps.remove(gate)
        mutate_index = next(
            index
            for index, step in enumerate(steps)
            if step.get("name") == "Update Stable version history"
        )
        steps.insert(mutate_index + 1, gate)
        with self.assertRaisesRegex(ValueError, "aliases may move only after"):
            policy._assert_docs(docs_path, workflow)

    def test_external_dockerfile_base_requires_digest(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "Dockerfile"
            path.write_text("FROM python:3.11-alpine\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "reviewed digest"):
                policy._assert_dockerfile_bases(path)

    def test_pinned_base_and_internal_stage_pass(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "Dockerfile"
            path.write_text(
                "FROM python:3.11-alpine@sha256:" + "a" * 64 + " AS base\n"
                "FROM base AS final\n",
                encoding="utf-8",
            )
            policy._assert_dockerfile_bases(path)

    def test_webui_architecture_neutral_builds_use_native_platform(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "Dockerfile"
            path.write_text(
                "FROM --platform=$BUILDPLATFORM python:3.11-alpine@sha256:"
                + "a" * 64
                + " AS docs\n"
                "RUN python3 -m pip install mkdocs\n"
                "FROM --platform=$BUILDPLATFORM node:22-alpine@sha256:"
                + "b" * 64
                + " AS build\n"
                "RUN npm ci\n"
                "FROM nginx:1.27-alpine@sha256:"
                + "c" * 64
                + "\n",
                encoding="utf-8",
            )
            policy._assert_webui_build_platforms(path)

    def test_webui_docs_build_cannot_run_under_target_emulation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "Dockerfile"
            path.write_text(
                "FROM --platform=$TARGETPLATFORM python:3.11-alpine AS docs\n"
                "FROM --platform=$BUILDPLATFORM node:22-alpine AS build\n"
                "FROM nginx:1.27-alpine\n",
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ValueError, "'docs' stage"):
                policy._assert_webui_build_platforms(path)

    def test_webui_node_build_cannot_run_under_target_emulation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "Dockerfile"
            path.write_text(
                "FROM --platform=$BUILDPLATFORM python:3.11-alpine AS docs\n"
                "FROM --platform=$TARGETPLATFORM node:22-alpine AS build\n"
                "FROM nginx:1.27-alpine\n",
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ValueError, "'build' stage"):
                policy._assert_webui_build_platforms(path)

    def test_webui_runtime_must_remain_target_platform(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "Dockerfile"
            path.write_text(
                "FROM --platform=$BUILDPLATFORM python:3.11-alpine AS docs\n"
                "FROM --platform=$BUILDPLATFORM node:22-alpine AS build\n"
                "FROM --platform=$BUILDPLATFORM nginx:1.27-alpine\n",
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ValueError, "runtime stage"):
                policy._assert_webui_build_platforms(path)


if __name__ == "__main__":
    unittest.main()
