"""Backend policy service for supervised Stable application updates.

This module derives immutable release-asset locations and capability blockers, then
delegates fixed operations to :mod:`app.engine.update_supervisor`.  It never imports
Docker libraries, executes a command, accepts an image reference from the browser, or
interprets a release plan itself.
"""

from __future__ import annotations

import hashlib
import os
import re
from dataclasses import dataclass
from typing import Any, Literal
from urllib.parse import quote, urlsplit

from pydantic import ValidationError

from .. import __version__
from ..build_identity import is_exact_source_revision
from ..config import Secrets
from ..state import AppState
from ..stores.update_operations import UpdateOperationConflict, UpdateOperationStore
from .update_supervisor import (
    SUPERVISOR_PROTOCOL_MIN,
    CurrentReleaseIdentity,
    ObservedStableRelease,
    SupervisorIdentity,
    SupervisorRejected,
    SupervisorStatus,
    SupervisorTerminalPage,
    SupervisorUnavailable,
    UpdateCapability,
    UpdateIssue,
    UpdateJob,
    UpdatePreflight,
    UpdateReceipt,
    UpdateRelease,
    UpdateReleaseDiscovery,
    UpdateScope,
    UpdateStatus,
    UpdateSupervisorClient,
)

_RELEASE_ID_RE = re.compile(r"^v(?P<version>[0-9]+\.[0-9]+\.[0-9]+)$")
_JOB_ID_RE = re.compile(r"^[A-Za-z0-9-]{1,80}$")
_REQUIRED_SUPERVISOR_CAPABILITIES = ("preflight", "start", "cancel", "rollback")

# Fields that the setup/settings surfaces can change in memory.  If their effective
# value differs from a fresh environment load, restarting the backend would silently
# lose that value.  Block update and expose field NAMES only; never compare/log values
# outside this process and never return any secret.
_RUNTIME_SECRET_FIELDS: tuple[str, ...] = (
    "es_url",
    "es_ca_cert",
    "es_verify_certs",
    "es_api_key",
    "es_mgmt_api_key",
    "openai_api_key",
    "anthropic_api_key",
    "litellm_api_key",
    "azure_openai_api_key",
    "azure_openai_endpoint",
    "azure_openai_api_version",
    "aws_access_key_id",
    "aws_secret_access_key",
    "aws_session_token",
    "aws_region",
    "vertex_project",
    "vertex_location",
    "vertex_api_key",
    "abuseipdb_api_key",
    "virustotal_api_key",
    "greynoise_api_key",
    "shodan_api_key",
    "censys_api_id",
    "censys_api_secret",
    "binaryedge_api_key",
    "ipinfo_token",
    "otx_api_key",
    "pulsedive_api_key",
    "spur_api_key",
    "xforce_api_key",
    "xforce_api_password",
    "urlscan_api_key",
    "hibp_api_key",
    "honeypot_access_key",
    "abusech_auth_key",
    "embedding_api_key",
    "mfa_obfuscation_key",
    "connector_secrets",
    "sso_client_secrets",
    "notification_secrets",
)


class UpdateCapabilityError(RuntimeError):
    def __init__(self, code: str, message: str, *, status_code: int = 409) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = int(status_code)


@dataclass(frozen=True, slots=True)
class _ReleaseObservation:
    """One coherent discovery read and its private supervisor candidate."""

    projection: UpdateReleaseDiscovery
    candidate: UpdateRelease | None = None


def validate_job_id(value: str) -> str:
    if not _JOB_ID_RE.fullmatch(str(value or "")):
        raise UpdateCapabilityError(
            "invalid_job_id", "The update job ID is invalid.", status_code=422
        )
    return value


def _version_tuple(value: str) -> tuple[int, int, int] | None:
    match = re.fullmatch(r"([0-9]+)\.([0-9]+)\.([0-9]+)", str(value or ""))
    if not match:
        return None
    return tuple(int(part) for part in match.groups())  # type: ignore[return-value]


def _release_channel() -> str:
    configured = os.getenv("TLSOC_RELEASE_CHANNEL", "testing").strip().lower()
    return "stable" if configured == "stable" else "testing"


def _build_sha() -> str:
    """The running build's stamped revision, normalized for the shared predicate.

    Whether that value is *pinnable* is decided by
    ``build_identity.is_exact_source_revision`` — the same predicate reported as an
    advisory by ``/api/health/build-info`` — so an operator can see, from build-info
    alone, why supervised updates refuse this build.
    """

    value = os.getenv("TLSOC_BUILD_SHA", "unknown").strip().lower()
    return value if value and value != "unknown" else "unknown"


def _repository_coordinates(repository_url: str) -> tuple[str, str]:
    parsed = urlsplit(repository_url)
    parts = [part for part in parsed.path.split("/") if part]
    if parsed.scheme != "https" or parsed.netloc.lower() != "github.com" or len(parts) != 2:
        raise UpdateCapabilityError(
            "invalid_release_repository", "The configured Stable release repository is invalid."
        )
    return parts[0], parts[1]


def _dynamic_secret_fields(current: Secrets) -> list[str]:
    """Return restart-unsafe field names only; values never leave this function."""
    durable = Secrets(_env_file=None)
    return [
        field
        for field in _RUNTIME_SECRET_FIELDS
        if getattr(current, field, None) != getattr(durable, field, None)
    ]


def _auth_secret_is_durable(current: Secrets) -> bool:
    if not current.auth_jwt_secret:
        return False
    durable = Secrets(_env_file=None)
    return bool(durable.auth_jwt_secret) and durable.auth_jwt_secret == current.auth_jwt_secret


class UpdateService:
    def __init__(self, state: AppState) -> None:
        self.state = state
        self.client = UpdateSupervisorClient(
            state.secrets.update_supervisor_socket,
            timeout_seconds=state.secrets.update_supervisor_timeout_seconds,
            preflight_timeout_seconds=(
                state.secrets.update_supervisor_preflight_timeout_seconds
            ),
        )
        self._operations: UpdateOperationStore | None = None

    @property
    def operations(self) -> UpdateOperationStore:
        if self._operations is None:
            self._operations = UpdateOperationStore(self.state.kv)
        return self._operations

    async def _supervisor_status(self) -> SupervisorStatus:
        try:
            return await self.client.status()
        except (SupervisorUnavailable, SupervisorRejected, ValidationError):
            return SupervisorStatus(
                available=False,
                state="unavailable",
                capabilities={},
                message="The supervised updater is not installed or reachable.",
            )

    async def terminal_jobs(self, *, limit: int = 64) -> SupervisorTerminalPage:
        """Read the updater's bounded durable completion replay window."""
        return await self.client.terminals(limit=limit)

    async def _release_observation(self) -> _ReleaseObservation:
        """Project mutable Stable metadata without overstating verification.

        A newer branch ``VERSION`` is only an observation.  The private candidate
        retains the commit and canonical repository coordinates solely so the
        supervisor can verify the signed immutable release plan during preflight.
        None of those coordinates or digests enter ``UpdateStatus``.
        """
        config = self.state.prefs.release_updates
        branch = str(config.stable_branch)
        if not bool(config.enabled):
            return _ReleaseObservation(
                UpdateReleaseDiscovery(state="not_checked", branch=branch)
            )
        try:
            discovery = await self.state.release_discovery.discover(config)
        except Exception:  # noqa: BLE001 — status must degrade to curated evidence
            return _ReleaseObservation(
                UpdateReleaseDiscovery(
                    state="error",
                    branch=branch,
                    issue=UpdateIssue(
                        code="release_discovery_error",
                        message="Stable release metadata could not be evaluated.",
                        remediation="Retry the release check after GitHub connectivity is restored.",
                    ),
                )
            )

        stable = discovery.channels.get("stable")
        if not discovery.enabled or stable is None or stable.state == "disabled":
            return _ReleaseObservation(
                UpdateReleaseDiscovery(
                    state="not_checked",
                    checked_at=discovery.checked_at,
                    branch=branch,
                )
            )

        checked_at = stable.checked_at or discovery.checked_at
        if stable.state == "unavailable":
            raw_code = str(stable.error_code or "release_discovery_unavailable")
            safe_code = re.sub(r"[^a-z0-9_]+", "_", raw_code.lower()).strip("_")
            return _ReleaseObservation(
                UpdateReleaseDiscovery(
                    state="unavailable",
                    checked_at=checked_at,
                    branch=branch,
                    issue=UpdateIssue(
                        code=(safe_code or "release_discovery_unavailable")[:80],
                        message=(
                            str(stable.error_message)
                            if stable.error_message
                            else "Stable release metadata is unavailable."
                        )[:500],
                        remediation="Retry the release check after GitHub connectivity is restored.",
                    ),
                )
            )

        target = _version_tuple(str(stable.version or ""))
        current = _version_tuple(__version__)
        branch_sha = str(stable.commit_sha or "").lower()
        release_sha = str(stable.release_commit_sha or "").lower()
        if (
            target is None
            or current is None
            or not is_exact_source_revision(branch_sha)
            or not is_exact_source_revision(release_sha)
        ):
            return _ReleaseObservation(
                UpdateReleaseDiscovery(
                    state="error",
                    checked_at=checked_at,
                    branch=branch,
                    issue=UpdateIssue(
                        code="invalid_release_metadata",
                        message="Stable release metadata is incomplete or invalid.",
                        remediation="Publish a valid VERSION and 40-character commit identity on Stable.",
                    ),
                )
            )

        version = str(stable.version)
        release_id = f"v{version}"
        observed = ObservedStableRelease(release_id=release_id, version=version)
        if bool(stable.stale) or bool(discovery.cache.stale):
            return _ReleaseObservation(
                UpdateReleaseDiscovery(
                    state="stale",
                    checked_at=checked_at,
                    branch=branch,
                    observed_release=observed,
                    issue=UpdateIssue(
                        code="stale_release_metadata",
                        message=(
                            "The latest Stable check failed; the last observation "
                            "cannot authorize an update."
                        ),
                        remediation="Retry the release check before preflight.",
                    ),
                )
            )
        if target <= current:
            return _ReleaseObservation(
                UpdateReleaseDiscovery(
                    state="current",
                    checked_at=checked_at,
                    branch=branch,
                    observed_release=observed,
                )
            )

        candidate = UpdateRelease(
            release_id=release_id,
            version=version,
            tag=release_id,
            commit_sha=release_sha,
            repository_url=discovery.repository_url,
        )
        return _ReleaseObservation(
            UpdateReleaseDiscovery(
                state="candidate_observed",
                checked_at=checked_at,
                branch=branch,
                observed_release=observed,
            ),
            candidate,
        )

    async def _status_with_candidate(
        self,
    ) -> tuple[UpdateStatus, UpdateRelease | None]:
        supervisor = await self._supervisor_status()
        observation = await self._release_observation()
        blockers: list[UpdateIssue] = []
        warnings: list[UpdateIssue] = []
        state_backend = str(self.state.secrets.state_backend or "elasticsearch")
        release_channel = _release_channel()
        build_sha = _build_sha()
        release_identity_blocked = False

        if release_channel != "stable":
            release_identity_blocked = True
            blockers.append(
                UpdateIssue(
                    code="stable_release_required",
                    message=(
                        "One-click updates are unavailable from a Testing or "
                        "source-built deployment."
                    ),
                    remediation=(
                        "Use the documented host-authorized bootstrap from an exact "
                        "annotated Stable release tag."
                    ),
                )
            )
        if not is_exact_source_revision(build_sha):
            release_identity_blocked = True
            blockers.append(
                UpdateIssue(
                    code="immutable_build_identity_required",
                    message=(
                        "The running application does not expose an immutable Stable "
                        "source revision."
                    ),
                    remediation=(
                        "Use the documented host-authorized bootstrap from a signed "
                        "Stable release."
                    ),
                )
            )

        if not bool(self.state.secrets.auth_enabled):
            blockers.append(
                UpdateIssue(
                    code="auth_required",
                    message="Supervised updates require authentication.",
                    remediation=(
                        "Enable authentication and sign in as the built-in super "
                        "administrator."
                    ),
                )
            )
        if bool(self.state.secrets.auth_enabled) and not _auth_secret_is_durable(
            self.state.secrets
        ):
            blockers.append(
                UpdateIssue(
                    code="durable_auth_secret_required",
                    message="The authentication signing secret is not restart-durable.",
                    remediation=(
                        "Set AUTH_JWT_SECRET in the deployment environment, then "
                        "restart once."
                    ),
                )
            )
        if state_backend != "postgres":
            blockers.append(
                UpdateIssue(
                    code="postgres_state_required",
                    message=(
                        "One-click updates currently support only PostgreSQL "
                        "application state."
                    ),
                    remediation=(
                        "Use the documented manual upgrade procedure for this state "
                        "backend."
                    ),
                )
            )

        dynamic_fields = _dynamic_secret_fields(self.state.secrets)
        if dynamic_fields:
            blockers.append(
                UpdateIssue(
                    code="dynamic_secrets_not_durable",
                    message=(
                        "Runtime-only secret or connection changes would be lost on restart: "
                        + ", ".join(dynamic_fields)
                    )[:500],
                    remediation=(
                        "Persist those fields in the deployment environment before "
                        "updating."
                    ),
                )
            )

        socket_present = self.client.socket_is_available()
        if not supervisor.available:
            blockers.append(
                UpdateIssue(
                    code="supervisor_unavailable",
                    message="The external update supervisor is not installed or reachable.",
                    remediation="Run the one-time updater bootstrap on the deployment host.",
                )
            )
        elif supervisor.protocol_version != SUPERVISOR_PROTOCOL_MIN:
            blockers.append(
                UpdateIssue(
                    code="supervisor_protocol_incompatible",
                    message="The installed update supervisor protocol is incompatible.",
                    remediation="Run the one-time updater bootstrap to replace the supervisor.",
                )
            )
        missing_capabilities = [
            name
            for name in _REQUIRED_SUPERVISOR_CAPABILITIES
            if not bool(supervisor.capabilities.get(name, False))
        ]
        if supervisor.available and missing_capabilities:
            blockers.append(
                UpdateIssue(
                    code="supervisor_capabilities_incomplete",
                    message=(
                        "The update supervisor is missing required capabilities: "
                        + ", ".join(missing_capabilities)
                    )[:500],
                    remediation=(
                        "Run the one-time updater bootstrap to install a compatible "
                        "supervisor."
                    ),
                )
            )

        warnings.append(
            UpdateIssue(
                code="infrastructure_unchanged",
                message="PostgreSQL and Redis images are deliberately not changed by this updater.",
                remediation=(
                    "Upgrade infrastructure separately using its vendor-supported "
                    "procedure."
                ),
            )
        )
        capability = UpdateCapability(
            supported=not blockers,
            blockers=blockers,
            warnings=warnings,
            scope=UpdateScope(state_backend=state_backend),
            supervisor=SupervisorIdentity(
                available=supervisor.available,
                protocol_version=supervisor.protocol_version,
                updater_version=supervisor.updater_version,
            ),
            bootstrap_required=(
                not socket_present
                or not supervisor.available
                or supervisor.protocol_version != SUPERVISOR_PROTOCOL_MIN
                or bool(missing_capabilities)
                or release_identity_blocked
            ),
        )
        return (
            UpdateStatus(
                capability=capability,
                current=CurrentReleaseIdentity(
                    version=__version__,
                    channel=release_channel,
                    commit_sha=build_sha,
                ),
                release_discovery=observation.projection,
                active_job=supervisor.active_job,
                last_job=supervisor.last_job,
            ),
            observation.candidate,
        )

    async def status(self) -> UpdateStatus:
        status, _candidate = await self._status_with_candidate()
        return status

    async def require_release(self, release_id: str) -> UpdateRelease:
        match = _RELEASE_ID_RE.fullmatch(str(release_id or ""))
        if not match:
            raise UpdateCapabilityError(
                "invalid_release_id",
                "Only an exact Stable release ID such as vX.Y.Z can be installed.",
                status_code=422,
            )
        status, release = await self._status_with_candidate()
        if not status.capability.supported:
            first = status.capability.blockers[0]
            raise UpdateCapabilityError(first.code, first.message)
        if release is None or release.release_id != release_id:
            raise UpdateCapabilityError(
                "release_not_installable",
                (
                    "That release is not the currently observed newer Stable "
                    "candidate. Signed supervisor preflight is still required."
                ),
            )
        return release

    @staticmethod
    def _request_fingerprint(
        operation: str, release_id: str, *, preflight_token: str = ""
    ) -> str:
        material = f"{operation}\0{release_id}\0{preflight_token}".encode("utf-8")
        return hashlib.sha256(material).hexdigest()

    async def _authorized_release(
        self,
        *,
        operation: Literal["preflight", "start"],
        release_id: str,
        idempotency_key: str,
        request_fingerprint: str,
    ) -> UpdateRelease:
        """Return a fresh authorization or one exact durable retry binding.

        A previously validated request can be replayed after backend replacement or
        mutable discovery drift.  Changed operation, release, token fingerprint, or
        idempotency key never inherits that authority.
        """
        if not _RELEASE_ID_RE.fullmatch(str(release_id or "")):
            raise UpdateCapabilityError(
                "invalid_release_id",
                "Only an exact Stable release ID such as vX.Y.Z can be installed.",
                status_code=422,
            )
        try:
            existing = await self.operations.find_exact(
                operation=operation,
                release_id=release_id,
                idempotency_key=idempotency_key,
                request_fingerprint=request_fingerprint,
            )
        except UpdateOperationConflict as exc:
            raise UpdateCapabilityError(
                "idempotency_conflict",
                "That idempotency key belongs to a different update request.",
            ) from exc
        except Exception as exc:  # noqa: BLE001 — durability gate is fail-closed
            raise UpdateCapabilityError(
                "update_journal_unavailable",
                "The durable update-operation journal is unavailable.",
                status_code=503,
            ) from exc
        if existing is not None:
            return existing.release

        release = await self.require_release(release_id)
        try:
            reserved = await self.operations.reserve(
                operation=operation,
                release=release,
                idempotency_key=idempotency_key,
                request_fingerprint=request_fingerprint,
            )
        except UpdateOperationConflict as exc:
            raise UpdateCapabilityError(
                "idempotency_conflict",
                "That idempotency key belongs to a different update request.",
            ) from exc
        except Exception as exc:  # noqa: BLE001 — never call supervisor without journal
            raise UpdateCapabilityError(
                "update_journal_unavailable",
                "The update request could not be durably authorized.",
                status_code=503,
            ) from exc
        return reserved.release

    def _supervisor_release(self, release: UpdateRelease) -> dict[str, Any]:
        owner, repository = _repository_coordinates(release.repository_url)
        tag_path = quote(release.tag, safe="")
        base = (
            f"https://github.com/{quote(owner, safe='')}/"
            f"{quote(repository, safe='')}/releases/download/{tag_path}"
        )
        return {
            **release.model_dump(mode="json"),
            "repository": f"{owner}/{repository}",
            "plan_url": f"{base}/upgrade-plan.json",
            "bundle_url": f"{base}/upgrade-plan.sigstore.json",
        }

    async def preflight(self, release_id: str, *, idempotency_key: str) -> UpdatePreflight:
        release = await self._authorized_release(
            operation="preflight",
            release_id=release_id,
            idempotency_key=idempotency_key,
            request_fingerprint=self._request_fingerprint("preflight", release_id),
        )
        result = await self.client.preflight(
            {
                "release": self._supervisor_release(release),
                "idempotency_key": idempotency_key,
            }
        )
        if result.release != release:
            raise SupervisorUnavailable("update supervisor returned a mismatched release")
        return result

    async def start(
        self,
        release_id: str,
        *,
        preflight_token: str,
        idempotency_key: str,
    ) -> UpdateJob:
        release = await self._authorized_release(
            operation="start",
            release_id=release_id,
            idempotency_key=idempotency_key,
            request_fingerprint=self._request_fingerprint(
                "start", release_id, preflight_token=preflight_token
            ),
        )
        result = await self.client.start(
            {
                "release": self._supervisor_release(release),
                "preflight_token": preflight_token,
                "idempotency_key": idempotency_key,
            }
        )
        if result.release_id != release.release_id:
            raise SupervisorUnavailable("update supervisor returned a mismatched job")
        return result

    async def job(self, job_id: str) -> UpdateJob:
        return await self.client.job(validate_job_id(job_id))

    async def cancel(self, job_id: str, *, idempotency_key: str) -> UpdateJob:
        return await self.client.cancel(
            validate_job_id(job_id), idempotency_key=idempotency_key
        )

    async def rollback(self, job_id: str, *, idempotency_key: str) -> UpdateJob:
        return await self.client.rollback(
            validate_job_id(job_id), idempotency_key=idempotency_key
        )

    async def receipt(self, job_id: str) -> UpdateReceipt:
        return await self.client.receipt(validate_job_id(job_id))
