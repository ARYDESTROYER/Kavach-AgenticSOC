"""All backend HTTP routes (the plugin contract)."""

from __future__ import annotations

import hashlib
import json
import logging
import math
import os
from collections.abc import Awaitable, Callable
from typing import Any, Literal
from urllib.parse import quote_plus

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, field_validator

from .. import __version__
from ..audit.changes import diff_changes
from ..audit.context import audit_context
from ..audit.identity import record_identity_event
from ..audit.prefs_write import audited_prefs_write
from ..audit.write import AuditUnavailableError, audited_write
from ..auth.session_limits import (
    REMEMBER_MAX_SECONDS,
    effective_roles,
    limits_for_username,
    remember_idle_window_seconds,
    remember_window_seconds,
)
from ..build_identity import build_identity_advisories, build_stamp
from ..config import (
    CAPS_MINIMUMS,
    Preferences,
    SourceInstance,
    SuppressionRule,
    map_retired_runbook_writes,
)
from ..connectors.registry import get_registry
from ..constants import (
    ActionType,
    CaseStatus,
    DecisionBy,
    Disposition,
    EntityType,
    FeedbackOutcome,
    IngestMode,
    OCSF_VERSION,
    SourceType,
    UserRole,
)
# Route-private helpers moved to engine modules by the chat revamp (SPEC §5.3) so the
# chat tools can share them without importing the HTTP layer. Each keeps its
# historical underscore name here (tests, ``routes_rules`` and route code use them;
# ``noqa: F401`` marks the re-export-only ones); the ``AppState``-reading ones are
# thin wrappers further down this module.
from ..engine.analyst_outcomes import CLASSIFIED_DISPOSITION_KEY, standing_analyst_disposition
from ..engine.case_cluster import WIDEN_LADDER as _WIDEN_LADDER  # noqa: F401
from ..engine.case_cluster import cluster_for_case, entity_events_widening
from ..engine.case_cluster import entity_field as _entity_field  # noqa: F401
from ..engine.case_cluster import manual_trigger_reason as _manual_trigger_reason
from ..engine.case_cluster import (  # noqa: F401
    reconstruct_cluster_from_case as _reconstruct_cluster_from_case,
)
from ..engine.case_cluster import scoped_entity_body as _scoped_entity_body  # noqa: F401
from ..engine.case_cluster import widen_windows as _widen_windows  # noqa: F401
from ..engine.case_rationale import audit_get as _audit_get  # noqa: F401
from ..engine.case_rationale import build_rationale as _build_rationale
from ..engine.case_tags import CASE_TAG_MAX_CHARS, CASE_TAG_MAX_COUNT  # noqa: F401
from ..engine.case_tags import CaseTagError, merge_case_tags
from ..engine.correlation import cluster_from_events
from ..engine.log_rows import LogFilter, browse_query, clamp_browse_limit, clamp_per_source_timeout
from ..engine.log_rows import browse_truncated as _browse_truncated
from ..engine.log_rows import demo_browse_targets, fan_out, tenant_browse_targets
from ..engine.log_rows import valid_rule_value as _valid_rule_value
from ..engine.log_rows import log_message as _log_message  # noqa: F401
from ..engine.log_rows import log_row as _log_row
from ..engine.log_rows import source_can_browse as _source_can_browse
from ..engine.metrics import feedback_stats
from ..engine.priority import advisory_bands
from ..engine.source_health import coverage_rollup, cursor_millis, sources_health_rows
from ..engine.source_health import (  # noqa: F401
    wallclock_last_event_millis as _wallclock_last_event_millis,
)
from ..engine.views import proposal_public as _proposal_public
from ..es.querybuilder import ids_query
from ..llm.pricing import (
    model_capabilities,
    model_catalog,
    model_may_embed,
    models_by_provider,
)
from ..models import (
    AUDIT_MAX_CHANGES,
    AuditTarget,
    Case,
    CaseComment,
    ChatConversation,
    ChatConversationSearchHit,
    ChatConversationUpdateRequest,
    ChatRequest,
    ChatResponse,
    Cluster,
    FeedbackEntry,
    InvestigateRequest,
    Proposal,
    RawEvent,
    StatusHistoryEntry,
    TraceStep,
    validate_avatar,
)
from ..state import AppState
from ..stores.base import CASE_STATUS_GROUPS
from ..stores.chat_conversations import (
    ChatHistoryUnavailable,
    ChatPinLimitReached,
)
from ..stores.proposals import (
    BULK_DECISION_LIMIT,
    MAX_DECISION_REASON_CHARS,
    evidence_summary,
    sanitize_decision_reason,
)
from ..tools.enrich import EnrichTool
from ..utils import (
    iso_now,
    new_id,
    now_utc,
    parse_millis_strict,
    relative_to_millis,
    to_millis,
)
from .deps import (
    _bearer,
    _sid_tag,
    current_user,
    current_username,
    evaluate_session,
    get_state,
    live_session_limits,
    require_admin,
    require_fresh_auth,
    require_permission,
    session_metadata,
)

logger = logging.getLogger("tlsoc.api")
router = APIRouter(prefix="/api")


# --------------------------------------------------------------------------- #
# Health
# --------------------------------------------------------------------------- #
class HealthResponse(BaseModel):
    """The public health envelope (also read by the webui to detect an in-memory
    store, ``store_type``).

    ``es_connected`` is a compatibility-stable alias that historically named the
    only supported state backend. New clients must use ``state_store_connected``;
    both fields deliberately carry the same own-state readiness result.
    """

    status: str
    version: str
    es_connected: bool = Field(
        description=(
            "Compatibility alias for state_store_connected; this does not describe "
            "log-source Elasticsearch connectivity."
        )
    )
    state_store_connected: bool = Field(
        description="Whether the selected owned-state backend passed its write-path probe."
    )
    state_backend: str = Field(
        description="Configured owned-state backend: elasticsearch, postgres, or sqlite."
    )
    store_type: str
    setup_complete: bool
    degraded: bool = Field(
        default=False,
        description=(
            "Whether a subsystem the product depends on is impaired while the state "
            "store itself is reachable. Additive: `status` keeps its historical "
            "meaning (state-store readiness) so existing clients are unaffected."
        ),
    )
    degraded_reasons: list[str] = Field(
        default_factory=list,
        description=(
            "Opaque, closed-vocabulary codes naming each active degradation. This "
            "endpoint is PUBLIC, so it carries no counts, source names or posture "
            "detail — the authenticated /api/diagnostics/health surface owns those."
        ),
    )


class LivenessResponse(BaseModel):
    status: str
    service: str
    version: str


class ReadinessResponse(BaseModel):
    status: str
    ready: bool
    version: str
    store_type: str
    checks: dict[str, bool]


class BuildInfoResponse(BaseModel):
    service: str
    version: str
    release_channel: str
    commit_sha: str
    build_time: str
    state_backend: str
    ocsf_version: str
    provenance_complete: bool
    provenance_missing: list[str]
    #: Additive advisories about a build identity that IS stamped but is not an
    #: exact source revision (see ``build_identity``). Never narrows the two
    #: completeness fields above, which keep their original broad semantics.
    provenance_advisories: list[str] = []


async def _state_store_probe(state: AppState) -> tuple[bool, str]:
    """Probe the persistence dependency that must work before traffic is accepted.

    Readiness performs a bounded write-path sentinel. Connectivity alone is not
    enough: a reachable database user or Elasticsearch key may still be read-only,
    in which case accepting alerts would create an acknowledgement/data-loss risk.
    The fixed sentinel is overwritten, so probe cardinality stays constant.
    """
    backend = str(
        getattr(state.secrets, "state_backend", "elasticsearch") or "elasticsearch"
    )
    if backend in {"sqlite", "postgres"}:
        store_type = "SQLiteStateStore" if backend == "sqlite" else "PostgresStateStore"
        engine = getattr(state, "sql_engine", None)
        if engine is None:
            return False, store_type
        try:
            async with engine.connect() as connection:
                await connection.exec_driver_sql("SELECT 1")
            sentinel = {"kind": "readiness_probe", "schema": 1}
            await state.kv.put("health", "readiness", sentinel)
            persisted = await state.kv.get("health", "readiness")
            if not persisted or persisted.get("kind") != "readiness_probe":
                return False, store_type
            return True, store_type
        except Exception as exc:  # noqa: BLE001 — probe failure is reported, never raised
            logger.warning("%s readiness probe failed: %s", backend, type(exc).__name__)
            return False, store_type

    store_type = type(state.es).__name__
    try:
        if not await state.es.ping_state():
            return False, store_type
        return bool(await state.es.write_state_probe()), store_type
    except Exception as exc:  # noqa: BLE001 — probe failure is reported, never raised
        logger.warning("Elasticsearch readiness probe failed: %s", type(exc).__name__)
        return False, store_type


def _release_channel(configured: str | None = None) -> str:
    """Return the independently stamped promotion channel.

    Branch promotion and SemVer are orthogonal: the same version candidate is
    exercised on Testing before its exact commit reaches main/Stable. Inferring a
    channel from a prerelease suffix would therefore mislabel Testing builds.
    """
    value = (configured or os.getenv("TLSOC_RELEASE_CHANNEL", "testing")).strip().lower()
    if value == "stable":
        return "stable"
    if value != "testing":
        logger.warning("Unknown TLSOC_RELEASE_CHANNEL=%r; reporting testing", value)
    return "testing"


# --------------------------------------------------------------------------- #
# Public degradation codes. CLOSED vocabulary, deliberately opaque.
# --------------------------------------------------------------------------- #
# ``/api/health`` is anonymous (the Console reads it before login), so it may never
# publish corpus counts, source names or detection posture — that detail lives on the
# ``settings:read``-gated ``/api/diagnostics/health``. But the incident this exists for
# ran for three days with this endpoint returning ``ok`` and the Console showing
# "Healthy" while the corpus sat at zero, so a coarse, count-free signal must be here:
# it is the only surface polled continuously and visible without a page visit.
DEGRADED_RAG_CORPUS_EMPTY = "rag_corpus_empty"
DEGRADED_RAG_PROJECTION_REFUSED = "rag_projection_refused"
DEGRADED_LLM_PROVIDER_UNAUTHENTICATED = "llm_provider_unauthenticated"
DEGRADED_LLM_PROVIDER_QUOTA = "llm_provider_quota_exhausted"
DEGRADED_LLM_PROVIDER_UNAVAILABLE = "llm_provider_unavailable"


def _degraded_reasons(state: AppState) -> list[str]:
    """Active degradations, from CACHED in-process state only.

    Hard constraint: this runs on an anonymous, un-rate-limited endpoint that the
    Console polls every 15 seconds, so it must never touch the vector store, the case
    store or the network. In particular it must never reach ``rag_stats()`` /
    ``list_documents()``, which call ``ensure_seeded()`` first — that would let an
    unauthenticated caller trigger an embedding spend (#6). Every value read here is
    already resident in memory. Fail-open: a health read never raises.
    """
    reasons: list[str] = []
    try:
        rag = getattr(state, "rag", None)
        rag_cfg = getattr(getattr(state, "prefs", None), "rag", None)
        if rag is not None and bool(getattr(rag_cfg, "enabled", False)):
            # ``corpus_empty`` is published by the retrieval path, which already knows
            # the count it just read — no extra read is performed here.
            if bool(getattr(rag, "corpus_degraded", False)):
                reasons.append(DEGRADED_RAG_CORPUS_EMPTY)
            refusal = getattr(rag, "last_refusal", None)
            if isinstance(refusal, dict) and refusal.get("collapsed"):
                reasons.append(DEGRADED_RAG_PROJECTION_REFUSED)
    except Exception:  # noqa: BLE001 — health must never fail on observability
        logger.debug("RAG degradation probe failed", exc_info=True)
    try:
        tracker = getattr(state, "_provider_health", None)
        provider_state = tracker.snapshot()["state"] if tracker is not None else "ok"
        reasons.extend(
            {
                "unauthenticated": [DEGRADED_LLM_PROVIDER_UNAUTHENTICATED],
                "quota_exhausted": [DEGRADED_LLM_PROVIDER_QUOTA],
                "unavailable": [DEGRADED_LLM_PROVIDER_UNAVAILABLE],
                "unsupported": [DEGRADED_LLM_PROVIDER_UNAVAILABLE],
            }.get(str(provider_state), [])
        )
    except Exception:  # noqa: BLE001
        logger.debug("provider degradation probe failed", exc_info=True)
    return sorted(set(reasons))


@router.get("/health", response_model=HealthResponse)
async def health(state: AppState = Depends(get_state)) -> HealthResponse:
    ready, store_type = await _state_store_probe(state)
    state_backend = str(
        getattr(state.secrets, "state_backend", "elasticsearch") or "elasticsearch"
    )
    reasons = _degraded_reasons(state)
    return HealthResponse(
        # ``status`` keeps its historical meaning — state-store readiness — because
        # release/update tooling gates on `status == 'ok'`. A subsystem degradation is
        # reported additively so it can be surfaced without blocking those flows.
        status="ok" if ready else "degraded",
        degraded=bool(reasons),
        degraded_reasons=reasons,
        version=__version__,
        # Backward-compatible wire name: this now truthfully represents the OWN-state
        # backend (ES, PostgreSQL, or SQLite), which is what existing clients use it for.
        es_connected=ready,
        state_store_connected=ready,
        state_backend=state_backend,
        store_type=store_type,
        setup_complete=state.prefs.setup_complete,
    )


@router.get("/health/live", response_model=LivenessResponse)
async def health_live() -> LivenessResponse:
    """Process liveness only; dependency failures must not trigger restart loops."""
    return LivenessResponse(
        status="ok",
        service="tlsoc-agentic-triage",
        version=__version__,
    )


@router.get(
    "/health/ready",
    response_model=ReadinessResponse,
    responses={503: {"model": ReadinessResponse}},
)
async def health_ready(state: AppState = Depends(get_state)) -> ReadinessResponse | JSONResponse:
    """Traffic readiness: fail closed when the suite cannot persist its own state."""
    ready, store_type = await _state_store_probe(state)
    result = ReadinessResponse(
        status="ready" if ready else "not_ready",
        ready=ready,
        version=__version__,
        store_type=store_type,
        checks={"state_store": ready},
    )
    if not ready:
        return JSONResponse(status_code=503, content=result.model_dump(mode="json"))
    return result


@router.get("/health/build-info", response_model=BuildInfoResponse)
async def health_build_info(state: AppState = Depends(get_state)) -> BuildInfoResponse:
    """Non-secret release identity for support, diagnostics, and upgrade checks."""
    commit_sha = build_stamp("TLSOC_BUILD_SHA")
    build_time = build_stamp("TLSOC_BUILD_DATE")
    provenance_missing = [
        label
        for label, value in (("commit_sha", commit_sha), ("build_time", build_time))
        if value == "unknown"
    ]
    return BuildInfoResponse(
        service="tlsoc-agentic-triage",
        version=__version__,
        release_channel=_release_channel(),
        commit_sha=commit_sha,
        build_time=build_time,
        state_backend=str(state.secrets.state_backend),
        ocsf_version=OCSF_VERSION,
        provenance_complete=not provenance_missing,
        provenance_missing=provenance_missing,
        # A stamped identity that is not an exact source revision is honest
        # provenance for a tarball/Nix/CI builder, so it stays `complete`; the
        # advisory is what explains why supervised updates refuse the same build.
        provenance_advisories=build_identity_advisories(commit_sha, build_time),
    )


# --------------------------------------------------------------------------- #
# Realtime — multiplexed in-process Server-Sent-Events stream (Round-3 Wave-1).
# A SINGLE long-lived GET that the webui subscribes to for push updates (case
# activity, in-app notifications, agent steps) instead of polling. Default-OFF: when
# Preferences.realtime.enabled is False the endpoint returns 204 so clients fall back
# to polling. Pure transport — it never feeds case_manager.decide() (#3); payloads are
# encoded verbatim by the bus (the PRODUCER fences/escapes #9 at its own boundary).
# --------------------------------------------------------------------------- #
# Topics the UI may subscribe to. A single case-detail view may also request
# 'cases:{case_id}' (exact-match topic) — allowed via the prefix below. ``chat``
# (Round 12) carries only owner-targeted ``chat.turn`` frames (``realtime.publish_chat_turn``).
_REALTIME_TOPICS = frozenset({"notifications", "inbox", "jobs", "cases", "agent", "chat", "runbooks"})

# The grants a principal must hold for a topic to be served (Round 12 WP-CM: case
# topics carry case ids and lifecycle status; Round 14 SPEC §4.10.15: the ``runbooks``
# topic carries ``case.runbook`` progress frames, served only with BOTH grants). A topic
# not listed here needs no grant beyond the stream itself.
_REALTIME_TOPIC_GRANTS: dict[str, tuple[tuple[str, str], ...]] = {
    "cases": (("cases", "read"),),
    "runbooks": (("runbooks", "read"), ("cases", "read")),
}


def _topic_grants(topic: str) -> tuple[tuple[str, str], ...]:
    """The grants ``topic`` needs (an exact case room ``cases:{id}`` needs ``cases:read``)."""
    if topic.startswith("cases:"):
        return _REALTIME_TOPIC_GRANTS["cases"]
    return _REALTIME_TOPIC_GRANTS.get(topic, ())


def gate_realtime_topics(topics: list[str], allows: Any) -> list[str]:
    """``topics`` without those the caller may not receive (``allows(resource, action)``
    is the caller's RBAC view). Pure; dropping an optional topic is not an access attempt,
    so nothing is audited."""
    return [t for t in topics if all(allows(resource, action) for resource, action in _topic_grants(t))]


@router.get("/events")
async def realtime_events(
    request: Request,
    topics: str = "notifications,cases,agent",
    lastEventId: str | None = None,
    state: AppState = Depends(get_state),
):
    """Subscribe to the in-process EventBus over SSE (``text/event-stream``).

    Cookie-authenticated (auto-gated by the router-level ``require_auth`` — an
    ``EventSource`` cannot send an Authorization header, so cookie auth is the only
    option). The authenticated principal scopes per-user audience filtering so a
    subscriber never sees another user's targeted events; an anonymous request (auth
    off) sees broadcasts only. ``Last-Event-ID`` (set automatically by EventSource on
    reconnect, or the ``?lastEventId=`` query param) replays missed frames from the
    bounded per-topic history.

    Default-OFF: returns ``204`` when ``Preferences.realtime.enabled`` is False so the
    client transparently falls back to polling. Disconnect/cancel is handled by the
    bus generator's ``finally`` (it unregisters the subscriber)."""
    from fastapi.responses import StreamingResponse

    realtime = getattr(state.execution_prefs, "realtime", None)
    if not bool(getattr(realtime, "enabled", False)):
        # Realtime is disabled — tell the client to fall back to polling.
        return Response(status_code=204)

    # Restrict to the allowlisted topics (plus an exact single-case topic
    # 'cases:{case_id}' for a case-detail view). An unknown topic is dropped.
    requested = [t.strip() for t in (topics or "").split(",") if t.strip()]
    allowed = [
        t for t in requested
        if t in _REALTIME_TOPICS or (t.startswith("cases:") and len(t) > len("cases:"))
    ]
    if not allowed:
        allowed = list(_REALTIME_TOPICS)
    # Round 12 (WP-CM): case topics carry case ids and lifecycle status (the live
    # ``case.changed`` queue nudges and per-case rooms), so they are served only to a
    # principal that may read cases; Round 14: the ``runbooks`` topic (``case.runbook``
    # progress frames) only to one holding ``runbooks:read`` AND ``cases:read``. A no-op
    # when auth or RBAC is off (``allows`` is then always true). Resolved WITHOUT the
    # denial audit row ``_enforce`` writes: dropping an optional topic from a stream is
    # not an access attempt.
    if any(_topic_grants(t) for t in allowed):
        from .deps import resolve_access

        view = await resolve_access(request)
        allowed = gate_realtime_topics(allowed, view.allows)
        if not allowed:
            return Response(status_code=204)

    user = current_user(request)
    username = getattr(user, "username", None) if user is not None else None
    # EventSource auto-sets Last-Event-ID on reconnect; honor the query param too.
    last_id = request.headers.get("last-event-id") or lastEventId

    bus = state.event_bus
    stream = bus.subscribe(allowed, username, last_event_id=last_id)
    return StreamingResponse(
        stream,
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


# --------------------------------------------------------------------------- #
# Setup wizard
# --------------------------------------------------------------------------- #
class SecretsUpdate(BaseModel):
    es_api_key: str | None = None
    es_mgmt_api_key: str | None = None
    es_url: str | None = None
    es_ca_cert: str | None = None
    openai_api_key: str | None = None
    anthropic_api_key: str | None = None
    # Optional self-hosted / LiteLLM (OpenAI-compatible) endpoint key — SECRET tier
    # (in-memory), set from the "Add local model" dialog. Never persisted / returned.
    litellm_api_key: str | None = None
    abuseipdb_api_key: str | None = None
    virustotal_api_key: str | None = None
    embedding_api_key: str | None = None


@router.get("/setup/status")
async def setup_status(
    state: AppState = Depends(get_state),
    request: Request = None,  # type: ignore[assignment]  # injected by FastAPI
) -> dict[str, Any]:
    """PUBLIC first-run status. Carries both the legacy wizard fields AND the Wave-1
    OOBE fields (auth/RBAC/user-count) the login/setup screen needs before a session
    exists. ``needs_user`` is true only when auth is enabled and NO users exist yet
    (so the UI shows the create-first-admin form). ``seeded_default`` hints that the
    demo Admin/Admin@123 credentials are live (subtle login hint)."""
    p = state.prefs
    auth_enabled = bool(state.secrets.auth_enabled)
    user_count = 0
    if auth_enabled:
        try:
            user_count = await state.users.count()
        except Exception:  # noqa: BLE001
            user_count = 0
    state_backend = str(
        getattr(state.secrets, "state_backend", "elasticsearch") or "elasticsearch"
    )
    es_connected = await state.es.ping()
    return {
        # Round 12 (Remember me): the sign-in page learns the policy here, so no new
        # public path is needed. Nothing secret: an on/off flag, a duration, and
        # whether THIS request's transport would refuse a remembered session.
        "remember_me": _remember_me_status(state, request),
        "setup_complete": p.setup_complete,
        "needs_user": bool(auth_enabled and user_count == 0),
        "auth_enabled": auth_enabled,
        "rbac_enabled": bool(getattr(p, "rbac", None) and p.rbac.enabled),
        "user_count": user_count,
        "seeded_default": bool(getattr(state, "_seeded_default_admin", False)),
        "configured": state.secrets.configured_status(),
        "data_view_pattern": p.data_view_pattern,
        "entity_mapping": {
            "source_ip_field": p.source_ip_field,
            "user_field": p.user_field,
            "host_field": p.host_field,
        },
        # Compatibility field: unlike /health.es_connected this is the historical
        # Elasticsearch/log-surface probe. The additive role fields prevent a
        # disconnected optional source from being mistaken for a failed SQL state
        # backend on vendor-neutral installations.
        "es_connected": es_connected,
        "es_required_for_state": state_backend == "elasticsearch",
        "es_connection_role": (
            "owned_state_and_log_source"
            if state_backend == "elasticsearch"
            else "log_source_only"
        ),
        "state_backend": state_backend,
    }


# NOTE: the legacy PUBLIC ``POST /api/setup/init-admin`` was REMOVED (H4 / FINDING
# #11). It bypassed the OOBE strong-password policy (it only required >= 8 chars), so a
# weak first-admin credential could be set. The webui now bootstraps the first admin
# ONLY through ``POST /api/setup/account`` (routes_setup.py), which enforces the
# server-side strong-password policy and self-locks. That is the single OOBE writer;
# there is no longer a second, weaker path. (Its ``/api/setup/init-admin`` entry was
# also dropped from ``deps.PUBLIC_API_PATHS``.)


#: Runtime keys that reach the Elasticsearch the suite keeps its OWN state (and so its
#: audit log) in when ``STATE_BACKEND=elasticsearch``: the management connection
#: (``es/client.py`` builds ``_mgmt`` from ``es_mgmt_api_key`` with ``es_url`` and
#: ``es_ca_cert``). ``es_api_key`` is NOT one of them: it is the read-only log key
#: (``_ro``, non-negotiable #1), never reaches the audit store, and so can never
#: repair it; during an outage it is refused like any other key.
_STATE_STORE_KEY_FIELDS = frozenset({"es_mgmt_api_key", "es_url", "es_ca_cert"})


def _secret_names_summary(prefix: str, updates: dict[str, Any]) -> str:
    """``"<prefix>: anthropic_api_key set, es_url cleared"``: names only, never a value."""
    parts = [
        f"{name} {'cleared' if updates[name] in (None, '') else 'set'}"
        for name in sorted(updates)
    ]
    return (f"{prefix}: " + ", ".join(parts))[:1000] if parts else prefix


def _secret_name_changes(prefix: str, names: Any) -> list[dict[str, Any]]:
    """One ``{field, secret: True}`` change per secret NAME (never a value, #10)."""
    return [
        {"field": f"{prefix}.{name}", "before": None, "after": None, "secret": True}
        for name in sorted(str(n) for n in names)
    ][:AUDIT_MAX_CHANGES]


async def _repair_audit_store_keys(
    state: AppState,
    request: Request,
    store_updates: dict[str, Any],
    row_for: Callable[[dict[str, Any]], dict[str, Any]],
) -> None:
    """Apply the audit store's own keys while the audit log cannot be written.

    On ``STATE_BACKEND=elasticsearch`` the audit log lives in the Elasticsearch these
    keys reach, so a broken key there must stay fixable: refusing it for want of an
    audit row would make the outage permanent. This is the one change applied before
    its audit row, so it is limited to those keys (``_STATE_STORE_KEY_FIELDS``; the
    caller audits the rest of the request normally), logged at error level every
    time it is used whatever happens to the row, and recorded afterwards through the
    new connection with ``applied_before_audit``. A row that still cannot be appended
    is counted like a dropped identity row. A repointed ``es_url`` means the old
    store never receives the row; the error log is the record there."""
    names = ", ".join(sorted(store_updates))
    await state.apply_secrets(store_updates)
    logger.error(
        "The audit log could not be written, so the audit store key(s) %s were applied "
        "before their audit row (applied_before_audit=true); any other key in the "
        "request is still audited first", names,
    )
    row = row_for(store_updates)
    try:
        await state.control_audit.record_strict(
            **{k: v for k, v in row.items() if k not in ("sink", "expected_revision", "context")},
            outcome="success", actor_type="human",
            tool_input={"applied_before_audit": True, "reason": "audit store keys repaired"},
            **audit_context(request).record_fields(),
        )
    except Exception as exc:  # noqa: BLE001 (the keys are applied; the drop is counted)
        from ..audit.identity import DROPS

        total = DROPS.note("settings.updated")
        logger.error("Audit row for the audit store key repair (%s) could not be appended "
                     "(%d dropped since start): %s", names, total, exc)


@router.post("/setup/secrets")
async def setup_secrets(
    body: SecretsUpdate,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("settings", "manage")),
) -> dict[str, Any]:
    # AuthZ: writing runtime secrets can repoint the read-only ES log source or clear
    # every key, so it requires settings:manage. When auth is DISABLED (the OOBE
    # default) the gate is a no-op; when auth is ENABLED, require_auth already forces a
    # session — which requires an admin to have been bootstrapped first — so there is no
    # pre-session window this could bypass.
    # exclude_unset (not exclude_none) so an explicit null can CLEAR/revoke a key.
    updates = body.model_dump(exclude_unset=True)
    if not updates:
        raise HTTPException(status_code=400, detail="No secret values provided")
    # Round 14 (SPEC §3.6): audited before it applies, recording the key NAMES only.
    def _row(names: dict[str, Any]) -> dict[str, Any]:
        return {
            "sink": "control", "action": "settings.updated",
            "target": {"type": "setting", "id": "runtime_keys", "label": "Runtime keys"},
            "expected_revision": None,
            "changes": _secret_name_changes("secrets", names),
            "action_type": ActionType.STATUS, "actor": current_username(request) or "",
            "surface": "setup", "context": audit_context(request),
            "result_summary": _secret_names_summary("runtime keys", names),
        }

    try:
        await audited_write(state, write=lambda: state.apply_secrets(updates), **_row(updates))
    except AuditUnavailableError:
        store_keys = sorted(_STATE_STORE_KEY_FIELDS.intersection(updates))
        backend = str(getattr(state.secrets, "state_backend", "elasticsearch") or "elasticsearch")
        if backend != "elasticsearch" or not store_keys:
            raise
        await _repair_audit_store_keys(
            state, request, {name: updates[name] for name in store_keys}, _row,
        )
        # Every other key in the request is an ordinary audited change against the
        # repaired store: refused with 503 (and not applied) when it is still down.
        # The refusal names what WAS applied, never "nothing was changed".
        others = {name: value for name, value in updates.items() if name not in store_keys}
        if others:
            try:
                await audited_write(
                    state, write=lambda: state.apply_secrets(others), **_row(others),
                )
            except AuditUnavailableError as exc:
                raise AuditUnavailableError(
                    "The audit log could not be written. The audit store "
                    f"{'keys' if len(store_keys) > 1 else 'key'} {', '.join(store_keys)} "
                    f"{'were' if len(store_keys) > 1 else 'was'} applied to repair it; "
                    f"the other {'keys were' if len(others) > 1 else 'key was'} not changed: "
                    f"{', '.join(sorted(others))}."
                ) from exc
    return {"ok": True, "configured": state.secrets.configured_status()}


@router.post("/setup/complete")
async def setup_complete(
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("settings", "manage")),
) -> dict[str, Any]:
    # Round 14 (SPEC §3.6): a settings write, audited before it becomes visible.
    _before, prefs = await audited_prefs_write(
        state,
        transform=lambda current: current.model_copy(update={"setup_complete": True}),
        actor=current_username(request) or "",
        context=audit_context(request),
        summary="first-run setup completed",
        surface="setup",
    )
    if prefs.polling_enabled:
        state.poller.start()
    return {"ok": True, "setup_complete": True}


# --------------------------------------------------------------------------- #
# Connectors + multi-source configuration (vendor-agnostic ingest).
#
# The first-run wizard lists connectors (each with its auth/config field schema),
# the operator configures one or more SOURCES, tests the connection, and saves.
# --------------------------------------------------------------------------- #
class SourceUpsert(BaseModel):
    """Add or update a configured log source (a connector instance)."""

    id: str
    source_type: str
    display_name: str = ""
    enabled: bool = True
    ingest_mode: str | None = None       # defaults to the connector's first mode
    is_primary: bool = False
    config: dict[str, Any] = Field(default_factory=dict)
    # The operator-DECLARED ceiling of this source's native severity ladder (see
    # ``config.SourceInstance.severity_scale_max``). Three-state on the wire, which is why
    # it is declared here as well as on the stored model:
    #   * OMITTED       → keep whatever the stored source already declares (carry-forward).
    #   * a number > 0  → declare that ceiling.
    #   * explicit null → CLEAR the declaration (undeclared → the 100 identity projection,
    #                     or the connector's seeded default where one exists).
    # ``upsert_source`` distinguishes the first two cases via ``model_fields_set``.
    #
    # Strict at the boundary: ``0``/negative 422, and so does a NON-FINITE literal. An
    # overflowing JSON number such as ``1e309`` parses to ``inf``, which passes ``> 0``,
    # divides without raising, would read every severity from that source as
    # Informational, and would re-serialize as the non-standard token ``Infinity``.
    severity_scale_max: float | None = Field(default=None, gt=0, allow_inf_nan=False)

    @field_validator("severity_scale_max", mode="before")
    @classmethod
    def _non_finite_ceiling_is_not_a_number(cls, value: Any) -> Any:
        """Render a non-finite ceiling as TEXT so the boundary can 422 it.

        ``allow_inf_nan=False`` already rejects it, but FastAPI's validation-error
        response ECHOES the offending input, and a non-finite float cannot be written into
        that JSON body at all — the rejection would itself fail to serialize. Handing the
        parser the value's text instead keeps the 422 renderable and still names exactly
        what was sent."""
        if isinstance(value, float) and not math.isfinite(value):
            return repr(value)
        return value


class ConnectorTestRequest(BaseModel):
    """Test the exact saved or draft source configuration without persisting it."""

    source_id: str | None = None
    source_type: str | None = None
    config: dict[str, Any] = Field(default_factory=dict)
    secrets: dict[str, str | None] = Field(default_factory=dict)


@router.get("/connectors")
async def list_connectors(state: AppState = Depends(get_state)) -> dict[str, Any]:
    """Every available connector + its wizard field schema (auth/config)."""
    reg = get_registry()
    return {"connectors": [m.model_dump(mode="json") for m in reg.manifests()]}


@router.get("/connectors/{source_type}")
async def get_connector(source_type: str, state: AppState = Depends(get_state)) -> dict[str, Any]:
    reg = get_registry()
    try:
        st = SourceType(source_type)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=f"Unknown source type: {source_type}") from exc
    manifest = reg.manifest(st)
    if manifest is None:
        raise HTTPException(status_code=404, detail=f"No connector for: {source_type}")
    return manifest.model_dump(mode="json")


@router.post("/connectors/test")
async def test_connector(
    body: ConnectorTestRequest,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("sources", "manage")),
) -> dict[str, Any]:
    """Validate the connector instance currently shown in the source editor.

    Draft config/secrets are request-scoped and never written to Preferences or the
    secret tier. With an empty body, preserve the legacy primary-source test.
    """
    if not body.source_id and not body.source_type and not body.config and not body.secrets:
        result = await state.log_source.test_connection(state.prefs)
        return result.model_dump(mode="json")

    saved = state.prefs.source_by_id(body.source_id) if body.source_id else None
    source_type_raw = body.source_type or (saved.source_type.value if saved else None)
    if not source_type_raw:
        raise HTTPException(status_code=400, detail="source_type or source_id is required")
    try:
        source_type = SourceType(source_type_raw)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"Unknown source type: {source_type_raw}") from exc

    reg = get_registry()
    cls = reg.get(source_type)
    if cls is None:
        raise HTTPException(status_code=400, detail=f"No connector for: {source_type.value}")
    if reg.is_receiver(source_type):
        return {
            "ok": False,
            "message": (
                "This push receiver has no safe one-shot connectivity probe. Save it, "
                "send a test event, and inspect source health."
            ),
            "mode": "push",
            "detail": {"supported": False},
        }

    effective_config: dict[str, Any] = {
        **((saved.config or {}) if saved else {}),
        **body.config,
        **(state.secrets.source_secrets(saved.id) if saved else {}),
        **{k: v for k, v in body.secrets.items() if v not in (None, "")},
    }
    draft = SourceInstance(
        id=(body.source_id or f"test-{source_type.value}"),
        source_type=source_type,
        display_name=(saved.display_name if saved else "Connection test"),
        enabled=True,
        ingest_mode=IngestMode.PULL,
        config=effective_config,
    )
    es_client, owned = state.es_client_for_source(draft)
    try:
        from ..connectors.elastic import ElasticConnector
        from ..connectors.opensearch import OpenSearchConnector
        from ..connectors.wazuh import WazuhConnector

        connector_cls = {
            SourceType.ELASTICSEARCH: ElasticConnector,
            SourceType.OPENSEARCH: OpenSearchConnector,
            SourceType.WAZUH: WazuhConnector,
        }.get(source_type)
        if connector_cls is None:
            raise HTTPException(
                status_code=400,
                detail=f"Draft connection testing is not implemented for {source_type.value}",
            )
        connector = connector_cls(
            es_client, config=effective_config, connector_id=draft.id
        )
        result = await connector.test_connection(state.prefs)
        return result.model_dump(mode="json")
    finally:
        if owned:
            await es_client.close()


@router.get("/sources")
async def list_sources(
    state: AppState = Depends(get_state),
    _=Depends(require_permission("sources", "read")),
) -> dict[str, Any]:
    # Demo Mode uses the same active-store isolation contract as cases/metrics/logs: only
    # the four throwaway source adapters are visible while active. Real source config is
    # preserved untouched and returns immediately on disable.
    if state.demo_active:
        return {"sources": state.demo_sources_overlay()}
    # `can_browse` is SERVER-AUTHORITATIVE and additive: it is the SAME
    # `_source_can_browse` predicate the browse routes gate on, so the inventory, the
    # health view, the demo overlays, and `GET /api/logs` cannot disagree about which
    # sources are browsable. Never trust a client-side re-derivation.
    reg = get_registry()
    rows = [
        {**s.model_dump(mode="json"), "can_browse": _source_can_browse(reg, s)}
        for s in state.prefs.sources
    ]
    return {"sources": rows}


def _source_secret_paths(sources: Any) -> list[str]:
    """``sources[<id>].config.<field>`` for every connector field the source's manifest
    marks secret (a RabbitMQ ``url`` carries its password), so a settings or source
    row withholds the value whole instead of only reducing it (SPEC §4.5.3). Accepts
    stored sources or request dicts; anything unreadable contributes nothing."""
    reg = get_registry()
    paths: list[str] = []
    for src in sources or []:
        if isinstance(src, dict):
            sid, kind = src.get("id"), src.get("source_type")
        else:
            sid, kind = getattr(src, "id", None), getattr(src, "source_type", None)
        if not isinstance(sid, str) or not sid:
            continue
        try:
            manifest = reg.manifest(SourceType(str(getattr(kind, "value", kind))))
        except ValueError:
            continue
        if manifest is None:
            continue
        paths.extend(
            f"sources[{sid}].config.{field.key}"
            for field in (*manifest.auth_fields, *manifest.config_fields) if field.secret
        )
    return paths


@router.post("/sources")
async def upsert_source(
    body: SourceUpsert,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("sources", "manage")),
) -> dict[str, Any]:
    reg = get_registry()
    try:
        st = SourceType(body.source_type)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"Unknown source type: {body.source_type}") from exc
    manifest = reg.manifest(st)
    if manifest is None:
        raise HTTPException(status_code=400, detail=f"No connector for: {body.source_type}")

    if body.ingest_mode:
        try:
            mode = IngestMode(body.ingest_mode)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=f"Invalid ingest_mode: {body.ingest_mode}") from exc
    else:
        mode = manifest.ingest_modes[0] if manifest.ingest_modes else IngestMode.PULL

    # Atomic read-modify-write (mutate_prefs): the existing-source read, the upsert, and
    # the save all happen under the prefs write lock against the FRESHEST prefs, so a
    # concurrent full-document writer (e.g. the nightly threshold-tuner) can't clobber
    # this edit with a stale snapshot — the fix for a source rename silently not
    # persisting. The transform is pure (no I/O), as mutate_prefs requires.
    def _apply(p: Preferences) -> Preferences:
        # Preserve managed/immutable metadata across an UPDATE. `SourceUpsert` carries
        # neither `configured_secrets` (secret NAMES, set only via
        # POST /sources/{id}/secrets) nor `created_at`, so a bare rebuild would wipe the
        # secret-name list and reset the creation date on EVERY enable/disable/make-
        # primary/edit — the secret VALUES survive in `connector_secrets`, but the
        # "N secrets" subline, the delete-confirm warning, and the Creation Date column
        # would all lie. Carry them forward from the existing source.
        existing = next((s for s in p.sources if s.id == body.id), None)
        # The row says "updated" or "added" from what was stored when the request
        # arrived. A source deleted, or added by another request, while that row was
        # appended is refused here (the failure row says why), never re-created under
        # an "updated" row or replaced under an "added" one.
        if existing is None and existed:
            raise HTTPException(status_code=404, detail="Source not found")
        if existing is not None and not existed:
            raise HTTPException(status_code=409, detail=f"Source '{body.id}' already exists")
        instance = SourceInstance(
            id=body.id,
            source_type=st,
            display_name=body.display_name or manifest.display_name,
            enabled=body.enabled,
            ingest_mode=mode,
            # Only a pull/search connector can own the primary query surface. A push
            # receiver marked primary would otherwise be rebuilt as an Elastic connector
            # and could query the unrelated global data view.
            is_primary=(body.is_primary and mode == IngestMode.PULL and not reg.is_receiver(st)),
            config=body.config,
            configured_secrets=(list(existing.configured_secrets) if existing else []),
            # Same carry-forward hazard as `configured_secrets` above: the severity-ladder
            # ceiling is set from the source editor, but EVERY enable/disable/make-primary
            # posts a body without it, and a bare rebuild would silently wipe the operator's
            # declaration (re-banding every one of that source's cases). `model_fields_set`
            # is what tells an OMITTED key from an explicit `null`, so omission preserves
            # the stored ceiling while an explicit null still CLEARS it on purpose.
            severity_scale_max=(
                body.severity_scale_max
                if "severity_scale_max" in body.model_fields_set
                else (existing.severity_scale_max if existing else None)
            ),
            **({"created_at": existing.created_at} if existing else {}),
        )
        # Wave 6: keep ``config['data_view_pattern']`` synced to the comma-join of the
        # non-ignore feed patterns, so the legacy single-pattern fallback + any reader of
        # ``data_view_pattern`` see the live surface MINUS muted ignore feeds. No-op when
        # no feeds are configured (the operator-set ``data_view_pattern`` is left intact).
        live_dv = instance.live_data_view()
        if live_dv:
            instance.config["data_view_pattern"] = live_dv
        # Upsert by id; a new primary unsets any previous primary. The others are
        # copied, never changed in place: the transform is pure (the audited write
        # records the stored document as it was before the edit).
        others = [s for s in p.sources if s.id != body.id]
        if instance.is_primary:
            others = [
                s.model_copy(update={"is_primary": False}) if s.is_primary else s
                for s in others
            ]
        return p.model_copy(update={"sources": others + [instance]})

    # Round 14 (SPEC §3.6, §4.5.3): a source change is audited before it is visible,
    # with the changed fields (a source URL cut to scheme and host, credentials and any
    # field the connector marks secret withheld).
    existed = any(s.id == body.id for s in state.prefs.sources)
    _before, prefs = await audited_prefs_write(
        state,
        transform=_apply,
        actor=current_username(request) or "",
        context=audit_context(request),
        summary=f"{'updated' if existed else 'added'} source '{body.id}' ({st.value})",
        action="source.updated" if existed else "source.created",
        surface="sources",
        target=AuditTarget(type="source", id=body.id,
                           label=body.display_name or manifest.display_name or body.id),
        secret_fields=_source_secret_paths([{"id": body.id, "source_type": st.value}]),
    )
    state.rebuild_log_source()
    await state.reconcile_receivers()
    return {"ok": True, "sources": [s.model_dump(mode="json") for s in prefs.sources]}


@router.delete("/sources/{source_id}")
async def delete_source(
    source_id: str,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("sources", "manage")),
) -> dict[str, Any]:
    # Atomic remove under the prefs write lock (mutate_prefs) so a concurrent full-doc
    # writer can't resurrect the deleted source by saving a stale snapshot. The 404 is
    # raised from inside the transform (before any save), so nothing is persisted when
    # the source is absent.
    def _apply(p: Preferences) -> Preferences:
        remaining = [s for s in p.sources if s.id != source_id]
        if len(remaining) == len(p.sources):
            raise HTTPException(status_code=404, detail="Source not found")
        return p.model_copy(update={"sources": remaining})

    # Round 14 (SPEC §3.6): audited before the source disappears.
    gone = next((s for s in state.prefs.sources if s.id == source_id), None)
    _before, prefs = await audited_prefs_write(
        state,
        transform=_apply,
        actor=current_username(request) or "",
        context=audit_context(request),
        summary=f"deleted source '{source_id}'",
        action="source.deleted",
        surface="sources",
        target=AuditTarget(type="source", id=source_id,
                           label=(getattr(gone, "display_name", "") or source_id)),
        secret_fields=_source_secret_paths([gone] if gone is not None else []),
    )
    remaining = prefs.sources
    state.rebuild_log_source()
    # Revoke now-orphaned in-memory credentials and stop a deleted background
    # receiver before returning success.
    state.secrets.connector_secrets.pop(source_id, None)
    await state.reconcile_receivers()
    # A deleted source's ingest history no longer maps to any live source: drop the
    # durable Noise-Reduction ingest counters + anomaly-baseline sketches so the funnel
    # stops over-reporting inbound volume from a source that is gone. Advisory only —
    # neither feeds case_manager.decide() (#3) nor recomputes a cluster_signature (#4) —
    # and best-effort, so a counter glitch never fails a delete that already succeeded.
    try:
        await state.noise_counters.clear()
        await state.baseline_store.clear()
    except Exception:  # noqa: BLE001 — advisory counters; never fail the source delete
        logger.warning("noise/baseline clear after source delete failed; continuing", exc_info=True)
    return {"ok": True, "sources": [s.model_dump(mode="json") for s in remaining]}


@router.post("/sources/{source_id}/secrets")
async def set_source_secrets(
    source_id: str,
    body: dict[str, str | None],
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("sources", "manage")),
) -> dict[str, Any]:
    """Set/clear a source's secret fields (e.g. a webhook token, a Splunk key).

    Values go to the secret tier (in memory), NEVER to the persisted config; only
    the configured field NAMES are recorded on the SourceInstance (#10). Round 14
    (SPEC §3.6): audited before the credentials change, naming the fields only."""
    src = next((s for s in state.prefs.sources if s.id == source_id), None)
    if src is None:
        raise HTTPException(status_code=404, detail="Source not found")
    configured: list[str] = []
    # ``set_source_secret`` clears a field for None or "" and sets it otherwise.
    cleared = {field for field, value in body.items() if value in (None, "")}
    set_now = set(body) - cleared

    # Persist only the configured secret NAMES onto the source, atomically against the
    # freshest prefs (mutate_prefs) so a concurrent full-doc writer can't drop the update.
    # The names are what the secret tier WILL hold once this request applies.
    def _apply(p: Preferences) -> Preferences:
        cur = next((s for s in p.sources if s.id == source_id), None)
        if cur is None:
            # Deleted while the row was appended: refused before anything is saved or
            # any credential is set, so the failure row ("Not applied") is true and no
            # credential is left behind for a source that no longer exists.
            raise HTTPException(status_code=404, detail="Source not found")
        names = (set(state.secrets.source_secrets(source_id)) | set_now) - cleared
        updated = cur.model_copy(update={"configured_secrets": sorted(names)})
        others = [s for s in p.sources if s.id != source_id]
        return p.model_copy(update={"sources": others + [updated]})

    async def _write() -> None:
        # The names are saved first and the credentials change in memory only after
        # that save succeeds: a failed save leaves the credentials as they were, so its
        # failure row ("Not applied") is true.
        await state.mutate_prefs(_apply)
        for field, value in body.items():
            state.secrets.set_source_secret(source_id, field, value)
        configured[:] = sorted(state.secrets.source_secrets(source_id).keys())

    await audited_write(
        state, sink="control", action="source.secrets_updated",
        target={"type": "source", "id": source_id,
                "label": getattr(src, "display_name", "") or source_id},
        expected_revision=None,
        changes=_secret_name_changes(f"sources[{source_id}].secrets", body),
        write=_write, action_type=ActionType.STATUS, actor=current_username(request) or "",
        surface="sources", context=audit_context(request),
        result_summary=_secret_names_summary(f"credentials of source '{source_id}'", body),
    )
    # Pull clients snapshot per-source connection credentials when they are built.
    # Rebuild the primary + fan-out immediately so a first key or key rotation takes
    # effect on the next query/poll rather than after another source edit or restart.
    # Receivers do not use these clients and are reconciled separately below; avoid
    # churning unrelated pull connections when only a webhook/broker token rotates.
    reg = get_registry()
    if reg.is_pull(src.source_type) or (
        src.ingest_mode == IngestMode.PULL and not reg.is_receiver(src.source_type)
    ):
        state.rebuild_log_source()
    await state.reconcile_receivers()
    return {"ok": True, "configured_secrets": configured}


class AnalyzeSampleRequest(BaseModel):
    """A pasted sample log/alert record for field-mapping suggestion (F9).

    The ``sample`` is UNTRUSTED, attacker-influenceable log data (#9): it is flattened
    to dotted paths and used ONLY to SUGGEST field mappings — never evaluated, never
    persisted to the config doc. Only the operator-confirmed mapping NAMES are saved
    later (via PUT /settings or POST /sources)."""

    sample: dict[str, Any] = Field(default_factory=dict)


@router.post("/sources/{source_id}/analyze-sample")
async def analyze_source_sample(
    source_id: str,
    body: AnalyzeSampleRequest,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("sources", "manage")),
) -> dict[str, Any]:
    """Suggest field mappings from a pasted SAMPLE record (F9; gated by sources:manage).

    Returns ``{suggested_mappings, suggested_evidence_fields, fields}`` — the
    suggested field-name overrides (``source_ip_field``/``user_field``/``host_field``/
    ``message_field``/``severity_field``/``rule_field``/...), which of the default
    case-evidence paths this record actually carries (the answer to "do my alerts
    carry the fields that decide the case?"), and the flattened path inventory the UI
    renders. Pure heuristic (no LLM/network). The sample is SANITIZED (flattened to
    paths only) and is NEVER persisted to the config doc / secret tier (#9);
    ``suggested_evidence_fields`` is stricter still — every entry is one of the
    backend's own constants matched against the sample, never a path echoed back."""
    from ..engine.sample_analysis import analyze_sample

    if not body.sample:
        raise HTTPException(status_code=400, detail="No sample record provided")
    # ``source_id`` is accepted for routing/UI context only; the analysis is pure +
    # stateless and does not require the source to exist (the wizard may analyse a
    # sample before saving the source).
    return analyze_sample(body.sample)


# Hard cap on a single pushed ingest body. Generous for a batched SIEM/EDR delivery,
# but bounded so an (unauthenticated — the receiver auths AFTER parsing) caller cannot
# exhaust memory with one giant/chunked POST (audit #14).
_MAX_INGEST_BODY_BYTES = 25 * 1024 * 1024  # 25 MiB


async def _read_capped_body(request: Request) -> bytes:
    """Buffer the request body with a hard byte cap, rejecting oversize with 413.

    Checks a declared Content-Length first (fast reject), then streams with a running
    cap so a lying/absent length (chunked transfer) cannot bypass the bound."""
    cl = request.headers.get("content-length")
    if cl is not None:
        try:
            if int(cl) > _MAX_INGEST_BODY_BYTES:
                raise HTTPException(status_code=413, detail="request body too large")
        except ValueError:
            pass  # malformed header → rely on the streamed cap below
    chunks: list[bytes] = []
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > _MAX_INGEST_BODY_BYTES:
            raise HTTPException(status_code=413, detail="request body too large")
        chunks.append(chunk)
    return b"".join(chunks)


@router.post("/ingest/{source_id}")
async def ingest_push(
    source_id: str, request: Request, state: AppState = Depends(get_state)
) -> dict[str, Any]:
    """HTTP push ingestion endpoint for a configured webhook/HEC source.

    A source/SIEM/EDR/SOAR POSTs alerts here; the matching receiver verifies auth,
    parses + normalises to OCSF, and the events flow into the SAME correlate→case
    pipeline the poller feeds. Per-source secrets (token/HMAC) are merged from the
    secret tier at call time (never persisted)."""
    src = next((s for s in state.prefs.sources if s.id == source_id and s.enabled), None)
    if src is None:
        raise HTTPException(status_code=404, detail="No enabled source with that id")
    reg = get_registry()
    cls = reg.get(src.source_type)
    if cls is None or not reg.is_receiver(src.source_type):
        raise HTTPException(status_code=400, detail="Source is not a push receiver")
    receiver = cls(config={**src.config, **state.secrets.source_secrets(source_id)}, connector_id=src.id)
    if not hasattr(receiver, "handle_request"):
        raise HTTPException(status_code=400, detail="Source is not an HTTP push receiver")
    body = await _read_capped_body(request)
    headers = {k: v for k, v in request.headers.items()}
    try:
        events = receiver.handle_request(body, headers, state.prefs)
    except PermissionError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc
    from ..engine.ingest import IngestBatchError

    try:
        # This is a real source's public delivery path, not a presentation control.
        # Demo Mode may hide real cases in the UI, but it must never divert accepted
        # production alerts into the throwaway stack where disable would destroy them.
        stats = await state.real_ingest_service.ingest(
            events, state.prefs, source_id=source_id,
        )
    except IngestBatchError as exc:
        # Do not claim acceptance when correlation/case persistence failed.  A 503
        # makes the retry contract explicit for webhook/HEC senders; broker receivers
        # see the same exception and withhold their ack/checkpoint.
        raise HTTPException(
            status_code=503,
            detail="Ingestion could not be persisted; retry the complete request",
            headers={"Retry-After": "1"},
        ) from exc
    return {"ok": True, **stats}


# --------------------------------------------------------------------------- #
# Browse logs per source (read-only). PULL sources run a bounded scoped search
# honoring the source's field mapping + TLS; PUSH sources return the in-memory
# live-tail buffer of recently-ingested events. Secrets are never returned.
# --------------------------------------------------------------------------- #
# ``_log_message`` / ``_log_row`` / ``_browse_truncated`` live in ``engine/log_rows.py``
# (chat revamp SPEC §5.3) and are re-exported at the top of this module under their
# historical names; tests and ``routes_rules`` import them from here.


@router.get("/sources/{source_id}/logs")
async def source_logs(
    source_id: str,
    limit: int = 100,
    query: str | None = None,
    from_: str | None = Query(default=None, alias="from"),
    to: str | None = None,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("sources", "read")),
) -> dict[str, Any]:
    """Browse the most-recent events for a source (bounded, read-only).

    Pull sources run a scoped read-only search honoring the source's field mapping +
    data_view_pattern (and its own TLS settings); push sources return the last N
    ingested events from the in-memory live-tail buffer. Hard-capped; secrets are
    never returned (rows are log data only).

    BOUNDED, NOT COMPLETE. ``limit`` is clamped to 1..200 and there is NO pagination,
    cursor, or offset: the response is always the MOST RECENT ``count`` rows for the
    requested window, never the full match set. The envelope echoes the effective
    ``limit`` and a ``truncated`` flag so a caller can say "most recent N" instead of
    implying completeness. ``mode`` distinguishes the two read paths:
    ``"search"`` = a real backing search (``from``/``to``/``query`` apply, and
    ``total`` reports the match count when the connector supplies one) and
    ``"buffer"`` = a push source's process-local, volatile in-memory live-tail ring,
    where ``from``/``to``/``query`` are IGNORED and nothing survives a restart.
    ``mode`` describes the FILTERS, never the durability of the backing store: a Demo
    Mode adapter reports ``"search"`` because it really does apply
    ``from``/``to``/``query`` and really does report a match ``total``, even though the
    ring it searches is itself in-memory."""
    limit = max(1, min(int(limit or 100), 200))  # hard cap
    # The four protocol-faithful demo adapters never enter prefs.sources. Their bounded
    # native-derived rings are exposed through the same browse row contract, with source
    # provenance made explicit on every result. No demo record reaches a tenant connector.
    if state.demo_active:
        conn = state.demo_source_connector(source_id)
        if conn is not None:
            from ..connectors.base import StructuredQuery

            result = await conn.search(
                state.prefs,
                StructuredQuery(
                    contains=(query or None), time_from=from_, time_to=to,
                    size=limit, sort_desc=True,
                ),
            )
            source_name = next(
                (str(row.get("display_name") or source_id)
                 for row in state.demo_sources_overlay()
                 if row.get("id") == source_id),
                source_id,
            )
            rows = [_log_row(ev) for ev in result.events]
            for row in rows:
                row["source_id"] = source_id
                row["source_name"] = source_name
            return {
                "source_id": source_id,
                # A demo adapter runs a REAL filtered search over its ring: the
                # `contains`/`time_from`/`time_to` above are all honoured and `total`
                # is a real match count, so the honest mode is "search". Calling it a
                # "buffer" would tell the operator the range/query did not apply.
                "mode": "search",
                "count": len(rows),
                "total": result.total,
                "limit": limit,
                "truncated": _browse_truncated(len(rows), limit, result.total),
                "logs": rows,
                "query": result.rendering.query if result.rendering else (query or "*"),
            }
        # A demo session must never query a real tenant connector, even when a caller
        # knows its id. Disable Demo Mode before browsing live data.
        raise HTTPException(status_code=404, detail="Source not found")
    src = next((s for s in state.prefs.sources if s.id == source_id), None)
    if src is None:
        raise HTTPException(status_code=404, detail="Source not found")
    reg = get_registry()
    cls = reg.get(src.source_type)
    if cls is None:
        raise HTTPException(status_code=400, detail="No connector for this source")

    # PUSH receivers → the live-tail buffer.
    if reg.is_receiver(src.source_type):
        rows = [_log_row(ev) for ev in state.ingest_service.recent_events_for_source(source_id, limit)]
        return {"source_id": source_id, "mode": "buffer", "count": len(rows),
                "limit": limit, "truncated": _browse_truncated(len(rows), limit, None),
                "logs": rows}

    # PULL connectors → a bounded, read-only scoped search honoring per-source TLS.
    if reg.is_pull(src.source_type):
        es_client, owned = state.es_client_for_source(src)
        try:
            from ..connectors.elastic import ElasticConnector
            from ..connectors.opensearch import OpenSearchConnector
            from ..connectors.wazuh import WazuhConnector
            from ..connectors.base import StructuredQuery
            if src.source_type == SourceType.OPENSEARCH:
                conn = OpenSearchConnector(es_client, config=src.config, connector_id=src.id)
            elif src.source_type == SourceType.WAZUH:
                conn = WazuhConnector(es_client, config=src.config, connector_id=src.id)
            else:
                conn = ElasticConnector(es_client, config=src.config, connector_id=src.id)
            sq = StructuredQuery(
                contains=(query or None), time_from=from_, time_to=to,
                size=limit, sort_desc=True,
            )
            try:
                result = await conn.search(state.prefs, sq)
            except Exception as exc:  # noqa: BLE001
                raise HTTPException(status_code=502, detail=f"log read failed: {exc}") from exc
            rows = [_log_row(ev) for ev in result.events]
            return {"source_id": source_id, "mode": "search", "count": len(rows),
                    "total": result.total,
                    "limit": limit,
                    "truncated": _browse_truncated(len(rows), limit, result.total),
                    "logs": rows,
                    "query": result.rendering.query if result.rendering else None}
        finally:
            if owned:
                try:
                    await es_client.close()
                except Exception:  # noqa: BLE001
                    pass

    raise HTTPException(status_code=501, detail="Browsing logs is not supported for this source")


# --------------------------------------------------------------------------- #
# Unified logs (Round 4 Wave 4) — scatter-gather browse across EVERY enabled,
# browse-capable source, merged newest-first with a MANDATORY source provenance
# column on each row. Read-only; secrets never returned; bounded (hard cap). One
# slow/failing source can never block the others (per-source timeout + gather with
# return_exceptions), so a partial result is served (#11 graceful degradation).
# --------------------------------------------------------------------------- #
# ``_source_can_browse`` and the scatter-gather core (per-source readers, timeout-
# guarded gather, merge) live in ``engine/log_rows.py`` (chat revamp SPEC §5.3) so
# the chat ``search_logs`` tool shares them; the route keeps its HTTP-only checks.


@router.get("/logs")
async def unified_logs(
    limit: int = 100,
    query: str | None = None,
    from_: str | None = Query(default=None, alias="from"),
    to: str | None = None,
    source_id: str | None = None,
    per_source_timeout: float = 8.0,
    # Round 14 (SPEC §4.6.1): exact filters, each optional and additive.
    rule: str | None = None,
    severity: str | None = None,
    severity_gte: str | None = None,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("sources", "read")),
) -> dict[str, Any]:
    """Browse recent logs across ALL enabled, browse-capable sources at once.

    Fans out the EXACT per-source read that ``GET /sources/{id}/logs`` does — a bounded
    scoped read-only search per PULL source (via ``es_client_for_source`` so per-source
    TLS + mgmt-key-dropped, #1) and the live-tail buffer for each PUSH source — then
    merges the rows newest-first. Every row carries a MANDATORY ``source_id`` +
    ``source_name`` provenance column. Read-only, hard-capped, and secrets are never
    returned (rows are the same ``_log_row`` log-data shape).

    Resilient by design: each source runs under ``asyncio.wait_for`` and the whole set
    under ``gather(return_exceptions=True)``, so one slow or failing source degrades to
    a per-source error entry and NEVER blocks the rest (partial success).

    ``source_id`` (OPTIONAL) scopes the fan-out to exactly one source, mirroring the
    private preview reader in ``routes_rules._read_recent_events``. Omitting it is the
    byte-identical all-sources behaviour. A ``source_id`` that is not visible in the
    CURRENT mode is a 404 — while Demo Mode is active a real tenant id is
    indistinguishable from an unknown one, so demo isolation leaks nothing — and a
    visible id that is not an eligible browse target for this route (disabled, no
    registered connector, or no ``browse`` capability) is a 501, the same status and
    detail the per-source sibling route uses.

    Each per-source status entry carries ``mode``: ``"search"`` = a real backing search
    (``from``/``to``/``query`` apply) and ``"buffer"`` = a push source's process-local,
    volatile in-memory live-tail ring, where ``from``/``to``/``query`` are IGNORED and
    nothing survives a restart. Without it a caller cannot tell a time-ranged query from
    a ring read in the merged view. ``mode`` describes the FILTERS, not the durability
    of the backing store: a Demo Mode adapter reports ``"search"`` because it really
    does apply ``from``/``to``/``query``.

    BOUNDED, NOT COMPLETE. ``limit`` is clamped to 1..200 and applied per source AND on
    the merge; there is NO pagination, cursor, or offset. The envelope echoes the
    effective ``limit`` and a ``truncated`` flag so a caller can say "most recent N"
    rather than implying it has seen everything. Each per-source status carries its own
    ``truncated``, computed by the SAME ``_browse_truncated`` rule the per-source
    sibling route uses, and the envelope ``truncated`` is the OR of the merge being cut
    with any single source being cut — so scoping to one source, or running a
    single-source deployment, reports exactly what ``GET /sources/{id}/logs`` reports
    for that same read.

    Round 14 (SPEC §4.6.1) adds three EXACT filters, each bound as a structured filter
    value and never as query text: ``rule`` (an equality match against any rule identity
    of an event: its rule field, rule name field or classified suite rule; 1 to 256
    characters on one line), ``severity`` (exactly one named level: ``info``, ``low``,
    ``medium``, ``high`` or ``critical``) and ``severity_gte`` (that level or above).
    A level is projected through EACH source's own severity ceiling before it is
    compared, so a 0 to 15 and a 0 to 100 source agree on what "High" means. Pull
    sources compile the filters into their own query (exact); a push source's
    live-tail ring is filtered here over the whole ring and, while a filter is active,
    also kept to an explicit ``from``/``to`` (``now``, ``now-3d``, an ISO-8601 instant),
    as a pull search and the rule summary are, so its rows and its "at least" total
    describe the window the page names (``query`` still does not apply to a ring, and
    ``mode`` stays ``"buffer"``). While any of them is active the envelope echoes
    ``filters: {rule, severity, severity_gte}`` (``null`` = that one not filtered), so a
    client can tell the filter was applied (an older backend ignores the parameters and
    echoes nothing), and each per-source status carries ``exact``: ``false`` when that
    source could only be filtered after a bounded read, so its rows are "at least"
    these. A request with none of them is answered exactly as before, key for key. An
    invalid value is a 400."""
    try:
        log_filter = LogFilter.parse(rule=rule, severity=severity, severity_gte=severity_gte)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    limit = clamp_browse_limit(limit)  # hard cap (per source AND on the merge)
    timeout = clamp_per_source_timeout(per_source_timeout)
    reg = get_registry()
    source_id = (source_id or "").strip() or None

    # Resolve the optional scope BEFORE any read coroutine is constructed (an unawaited
    # coroutine would leak on the raise path). Statuses mirror the per-source sibling.
    if source_id is not None:
        if state.demo_active:
            if source_id not in {
                str(row.get("id")) for row in state.demo_sources_overlay()
            }:
                # Identical to an unknown id: a demo session never reveals whether a
                # real tenant source exists behind it.
                raise HTTPException(status_code=404, detail="Source not found")
        else:
            scoped = next((s for s in state.prefs.sources if s.id == source_id), None)
            if scoped is None:
                raise HTTPException(status_code=404, detail="Source not found")
            if (
                not scoped.enabled
                or not _source_can_browse(reg, scoped)
                or reg.get(scoped.source_type) is None
            ):
                raise HTTPException(
                    status_code=501,
                    detail="Browsing logs is not supported for this source",
                )

    # Select the enabled + browse-capable sources, each paired with its reader and
    # read mode (engine/log_rows.py). Unsupported sources are skipped.
    if state.demo_active:
        targets = demo_browse_targets(
            state.demo_sources_overlay(),
            prefs=state.prefs,
            demo_source_connector=state.demo_source_connector,
            source_id=source_id,
        )
    else:
        targets = tenant_browse_targets(
            state.prefs.sources,
            prefs=state.prefs,
            registry=reg,
            es_client_for_source=state.es_client_for_source,
            ingest_service=state.ingest_service,
            source_id=source_id,
        )
    envelope = await fan_out(
        targets,
        browse_query(limit=limit, query=query, time_from=from_, time_to=to),
        per_source_timeout=timeout,
        log_filter=log_filter,
    )
    if log_filter.active:
        envelope["filters"] = log_filter.echo()
    return envelope


async def _cursor_millis(state: AppState, src) -> int:
    """Route-compat wrapper: :func:`app.engine.source_health.cursor_millis` over
    ``state.cursor_store`` (moved there by chat revamp SPEC §5.3)."""
    return await cursor_millis(getattr(state, "cursor_store", None), src)


async def _sources_health_rows(state: AppState) -> list[dict[str, Any]]:
    """Route-compat wrapper: :func:`app.engine.source_health.sources_health_rows` with
    its inputs read from the ``AppState`` exactly where the original helper read them
    (moved there by chat revamp SPEC §5.3). Real configured sources only."""
    return await sources_health_rows(
        state.prefs,
        poller=getattr(state, "poller", None),
        silent_sources=getattr(state, "silent_sources", None),
        cursor_store=getattr(state, "cursor_store", None),
        ingest_service=getattr(state, "ingest_service", None),
        last_event_map=getattr(state, "_source_last_event", {}) or {},
    )


@router.get("/sources/health")
async def sources_health(
    state: AppState = Depends(get_state),
    _=Depends(require_permission("sources", "read")),
) -> dict[str, Any]:
    """Per-source health for the sources dashboard (Round 4 Wave 4 + A5.2 coverage).

    Read-only, NO secrets. For every configured source it reports: enabled state, ingest
    mode, whether it is a PULL/PUSH connector and browse-capable, its durable poll position
    (``last_poll_millis``) / PUSH live-tail ``buffer_depth``, PLUS the additive
    coverage-observability fields (``last_poll_at``, ``last_poll_ok``, ``last_poll_error``,
    ``events_per_min``, ``last_event_millis``, ``silent``). A missing/legacy cursor reads as
    ``last_poll_millis: 0`` (never polled yet). Never mutates anything (this endpoint only
    reads); advisory only (#3); error strings are plain text (#9)."""
    # Demo Mode: overlay the four native simulators' real in-memory activity counters at
    # READ time only (never persisted), hiding real tenant health just like other active
    # demo stores. They are push-style adapters, not durable pull pollers, so no cursor
    # or wall-clock activity is fabricated.
    if state.demo_active:
        return {"sources": state.demo_source_health_overlay()}
    out = await _sources_health_rows(state)
    return {"sources": out}


@router.get("/sources/coverage")
async def sources_coverage(
    state: AppState = Depends(get_state),
    _=Depends(require_permission("sources", "read")),
) -> dict[str, Any]:
    """Aggregate ingest-coverage rollup — the "am I seeing everything?" big-number tile
    (A5.5; Google SecOps Health-Hub model). Read-only, advisory, NO secrets.

    Returns ``{sources_total, sources_enabled, sources_silent, events_per_min,
    alerts_triaged_24h, worst_last_event_seconds}`` computed over the configured sources,
    or over the isolated native demo sources while Demo Mode is active. ``alerts_triaged_24h``
    is the count of cases created in the last 24h, answered by a repository COUNT
    push-down (``CaseRepository.count_created_since`` — one backend count, zero full
    documents fetched) over the same 24h window the ``/metrics/noise-reduction``
    funnel's ``cases`` stage uses. Never raises — every sub-lookup degrades to a safe
    zero (#3/#4/#6/#9 untouched)."""
    # Demo reads are intentionally scoped to the throwaway demo stack, just like cases,
    # metrics, usage, and RAG. Including the four real simulator rows avoids the previous
    # misleading 0/0 coverage tile without leaking tenant-source health into a demo.
    rows = (
        state.demo_source_health_overlay()
        if state.demo_active
        else await _sources_health_rows(state)
    )
    # The source-derived numbers live in ``engine/source_health.coverage_rollup`` (chat
    # revamp SPEC §5.3) so the chat ``source_health`` tool reports the same rollup.
    rollup = coverage_rollup(rows, to_millis(now_utc()))

    # Cases created in the last 24h — a pure repository COUNT (no 5000-document fetch
    # just to ``len()`` a window). The 24h boundary is the same cutoff the noise-
    # reduction funnel's ``cases`` stage windows on, so the two stay consistent.
    alerts_triaged = 0
    try:
        from datetime import timedelta

        since_iso = (now_utc() - timedelta(hours=24)).isoformat()
        alerts_triaged = int(await state.cases.count_created_since(since_iso))
    except Exception:  # noqa: BLE001 — a store hiccup degrades to 0, never a 500
        alerts_triaged = 0

    # Explicit key order: the response is byte-identical to the pre-move envelope.
    payload = {
        "sources_total": rollup["sources_total"],
        "sources_enabled": rollup["sources_enabled"],
        "sources_silent": rollup["sources_silent"],
        "events_per_min": rollup["events_per_min"],
        "alerts_triaged_24h": int(alerts_triaged),
        "worst_last_event_seconds": rollup["worst_last_event_seconds"],
    }
    if state.demo_active:
        payload["demo"] = True
    return payload


@router.get("/sources/{source_id}/feeds")
async def source_feeds(
    source_id: str,
    state: AppState = Depends(get_state),
) -> dict[str, Any]:
    """The resolved EFFECTIVE feeds for a source (Wave 6) — for the per-source Feeds
    editor.

    Returns each configured feed with its derived id, role and the resolved
    ``auto_investigate`` (None → ``role=='alerts' or correlate``) so the UI shows the
    same effective behaviour the engine applies — including for a LEGACY
    ``{pattern, role, auto_correlate}`` / bare-string config (which upgrades on read,
    no migration). Secrets are never involved (feeds are non-secret config)."""
    src = next((s for s in state.prefs.sources if s.id == source_id), None)
    if src is None:
        raise HTTPException(status_code=404, detail="Source not found")
    feeds = [
        {
            "id": f.id,
            "pattern": f.pattern,
            "role": f.role.value,
            "enabled": f.enabled,
            "label": f.label,
            "query": f.query,
            "field_mapping": f.field_mapping,
            "message_field": f.message_field,
            "severity_floor": f.severity_floor,
            "correlate": f.correlate,
            "auto_investigate": f.effective_auto_investigate(),
            "auto_investigate_explicit": f.auto_investigate,
            "poll_interval_seconds": f.poll_interval_seconds,
        }
        for f in src.feeds()
    ]
    return {
        "source_id": source_id,
        "feeds": feeds,
        "data_view_pattern": src.live_data_view() or src.config.get("data_view_pattern", ""),
    }


# --------------------------------------------------------------------------- #
# Settings (Surface 5)
# --------------------------------------------------------------------------- #
@router.get("/settings")
async def get_settings(state: AppState = Depends(get_state)) -> dict[str, Any]:
    return {
        "prefs": state.prefs.model_dump(mode="json"),
        "configured": state.secrets.configured_status(),
        "read_only": state.prefs.read_only_settings_mode,
    }


@router.get("/settings/schema")
async def get_settings_schema(
    _=Depends(require_permission("settings", "read")),
) -> dict[str, Any]:
    """A best-effort JSON description of the settings sections + field types, derived
    from the Pydantic ``Preferences`` model (used by the UI to render/group forms).
    Purely descriptive — carries no values beyond defaults, NO secrets. settings:read."""
    from .settings_schema import settings_schema

    return settings_schema()


# The three rule-bearing Preferences blocks the G6 version ledger tracks, projected into
# ``kind -> {rule_id: config-json}`` maps for the settings-save version diff (Round-6 #10).
# DetectionRulesHome saves rules through PUT /api/settings (the whole prefs) — unlike the
# per-rule routes_rules.py CRUD, that path previously wrote NO version, leaving the ledger
# + rollback UI permanently empty.
def _rule_maps(prefs: Preferences) -> dict[str, dict[str, dict[str, Any]]]:
    detection = {rd.name: rd.model_dump(mode="json") for rd in (prefs.rule_catalog or [])}
    correlation = {
        name: r.model_dump(mode="json")
        for name, r in (prefs.correlation_rules or {}).items()
    }
    cfg = getattr(prefs, "threshold_automation", None)
    case_automation = {
        r.id: r.model_dump(mode="json") for r in (getattr(cfg, "rules", []) or [])
    }
    return {
        "detection": detection,
        "correlation": correlation,
        "case_automation": case_automation,
    }


def _rule_change_action(old_cfg: dict[str, Any], new_cfg: dict[str, Any]) -> str:
    """Classify a same-id rule edit: an enable/disable toggle (ONLY ``enabled`` changed)
    vs a general ``update`` — so the ledger records the same action verbs the per-rule
    routes_rules.py CRUD does."""
    changed = {k for k in set(old_cfg) | set(new_cfg) if old_cfg.get(k) != new_cfg.get(k)}
    if changed == {"enabled"}:
        return "enable" if new_cfg.get("enabled") else "disable"
    return "update"


async def _record_settings_rule_versions(
    state: AppState, request: Request, old: Preferences, new: Preferences
) -> None:
    """Append an immutable version snapshot for every rule CHANGED by a settings PUT
    (Round-6 #10 / G6 R5) — making the version ledger + one-click rollback real for
    rules saved through DetectionRulesHome (which rides PUT /api/settings, not the
    per-rule CRUD). Diffs old-vs-new for the three rule-bearing blocks and records one
    version per created / updated / enabled / disabled / deleted rule, plus ONE
    consolidated audit line. Best-effort + never raises: a versioning glitch must never
    fail the settings save (#2 append-only; #3 config-writer only — NEVER calls
    ``decide()``)."""
    store = getattr(state, "rule_versions", None)
    if store is None:
        return
    actor = current_username(request) or ""
    old_maps = _rule_maps(old)
    new_maps = _rule_maps(new)
    changes: list[str] = []
    for kind in ("detection", "correlation", "case_automation"):
        omap = old_maps[kind]
        nmap = new_maps[kind]
        for rule_id in sorted(set(omap) | set(nmap)):
            ocfg = omap.get(rule_id)
            ncfg = nmap.get(rule_id)
            if ncfg is None:
                action, cfg = "delete", ocfg or {}
            elif ocfg is None:
                action, cfg = "create", ncfg
            elif ocfg != ncfg:
                action, cfg = _rule_change_action(ocfg, ncfg), ncfg
            else:
                continue  # unchanged → no version recorded
            try:
                await store.record(
                    kind=kind, rule_id=rule_id, config=cfg, action=action,
                    actor=actor,
                    summary=f"{action} {kind} rule {rule_id} (via settings)"[:500],
                )
            except Exception:  # noqa: BLE001 — versioning is best-effort
                continue
            changes.append(f"{kind}:{rule_id}:{action}")
    if changes:
        try:
            await state.control_audit.record(
                action_type=ActionType.STATUS, surface="rules", actor=actor,
                result_summary=("rule versions recorded: " + ", ".join(changes))[:500],
            )
        except Exception:  # noqa: BLE001 — audit is best-effort
            pass


def _reject_out_of_range_caps(body: Any) -> None:
    """422 on a ``caps`` value below its declared floor that arrived in a REQUEST BODY.

    ``Preferences._clamp_caps`` is a ``mode="before"`` validator, so it REPAIRS the
    merged document before ``CapsConfig``'s ``ge=`` constraints are ever evaluated. That
    repair is mandatory for a STORED document — both preference loaders answer any
    validation error by returning a full default ``Preferences()``, which would silently
    revert ``auto_close``, the rule catalog and the source list — but it is the wrong
    answer for a live edit: it made this endpoint return 200 while storing a value the
    operator never typed, and ``timeout_seconds=1`` is exactly as unusable as the 0 they
    meant to reject. The sibling ``resilience`` block was already rejected by its own
    field constraints, so the surface was inconsistent as well as silent.

    It inspects the BODY, never the merged document, so an already-poisoned stored
    configuration stays loadable and repairable. The floors are read off
    :data:`CAPS_MINIMUMS` (derived from ``CapsConfig`` itself) rather than restated, so
    this can never drift from what it enforces. There is no upper bound to check — one
    would encode a single vendor's latency/context envelope as product policy.
    """
    if not isinstance(body, dict):
        return
    caps = body.get("caps")
    if not isinstance(caps, dict):
        return
    for key, floor in CAPS_MINIMUMS.items():
        if key not in caps:
            continue
        raw = caps[key]
        if isinstance(raw, bool) or not isinstance(raw, (int, float)):
            continue  # let normal field validation report a non-numeric value
        if float(raw) >= floor:
            continue
        raise HTTPException(
            status_code=422,
            detail=(
                f"Invalid settings: caps.{key} must be at least {floor} "
                f"(received {raw!r})"
            ),
        )


def _reject_out_of_range_remember_me(body: Any) -> None:
    """422 on an out-of-range or malformed ``session_policy.remember_me`` value that
    arrived in a REQUEST BODY (Round 12; ``research/remember-me.md`` §4.1).

    ``RememberMePolicy`` REPAIRS a stored document on load (clamping a duration into
    1–24 h, dropping a malformed flag) so one bad number can never reset the whole
    configuration. That repair is the wrong answer for a live edit: an administrator
    who asks for a 30-minute remembered session must not silently get a 1-hour one.
    Like :func:`_reject_out_of_range_caps` it inspects the BODY, never the merged
    document, so an already-stored value stays loadable. The bounds are read off the
    model, so this can never drift from what the loader enforces."""
    if not isinstance(body, dict):
        return
    policy = body.get("session_policy")
    if not isinstance(policy, dict):
        return
    rm = policy.get("remember_me")
    if rm is None:
        return
    if not isinstance(rm, dict):
        raise HTTPException(
            status_code=422,
            detail="Invalid settings: session_policy.remember_me must be an object",
        )
    from ..config import RememberMePolicy

    def _bad(field: str, expected: str, raw: Any) -> HTTPException:
        return HTTPException(
            status_code=422,
            detail=(
                f"Invalid settings: session_policy.remember_me.{field} must be "
                f"{expected} (received {raw!r})"
            ),
        )

    for flag in ("enabled", "allow_insecure_http"):
        if flag in rm and not isinstance(rm[flag], bool):
            raise _bad(flag, "true or false", rm[flag])
    lo, hi = RememberMePolicy._DURATION_BOUNDS
    if "duration_seconds" in rm:
        raw = rm["duration_seconds"]
        if isinstance(raw, bool) or not isinstance(raw, int) or not lo <= raw <= hi:
            raise _bad("duration_seconds", f"a whole number of seconds from {lo} to {hi}", raw)
    ilo, ihi = RememberMePolicy._IDLE_BOUNDS
    if "idle_seconds" in rm and rm["idle_seconds"] is not None:
        raw = rm["idle_seconds"]
        if isinstance(raw, bool) or not isinstance(raw, int) or not (
            raw == 0 or ilo <= raw <= ihi
        ):
            raise _bad(
                "idle_seconds",
                f"null, 0 (off) or a whole number of seconds from {ilo} to {ihi}",
                raw,
            )
    if "excluded_roles" in rm:
        roles = rm["excluded_roles"]
        if not isinstance(roles, list) or not all(isinstance(r, str) for r in roles):
            raise _bad("excluded_roles", "a list of role names", roles)
        if len(roles) > RememberMePolicy._MAX_ROLES:
            raise _bad(
                "excluded_roles",
                f"at most {RememberMePolicy._MAX_ROLES} role names",
                f"{len(roles)} names",
            )


@router.put("/settings")
async def put_settings(
    body: dict[str, Any],
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("settings", "manage")),
) -> dict[str, Any]:
    requested_embedding = body.get("embedding_model") if isinstance(body, dict) else None
    if isinstance(requested_embedding, dict) and requested_embedding.get("model"):
        embedding_id = str(requested_embedding.get("model") or "").strip()
        # Refuse only on POSITIVE catalog evidence of incapability — a bundled row
        # that declares other capabilities and not ``embedding``. The old check
        # refused whatever the catalog had never heard of, which is every self-hosted
        # / LiteLLM / vLLM / Ollama endpoint and every model newer than this build:
        # on a vendor-agnostic product that made the operator's own embedding
        # endpoint unconfigurable while an unknown completion id sailed through.
        # ``POST /api/llm/models/test {"mode": "embedding"}`` is the empirical probe
        # that answers the unknown case with evidence instead of with a JSON file.
        if not model_may_embed(embedding_id):
            raise HTTPException(
                status_code=422,
                detail=(
                    f"Invalid settings: the model catalog lists {embedding_id!r} "
                    "WITHOUT the embedding capability. If this endpoint really does "
                    "embed, verify it with POST /api/llm/models/test "
                    '{"model": "...", "mode": "embedding"} and register it as a '
                    "custom model."
                ),
            )
    # Build the partial deep-merge from the freshest Preferences document. Round 14
    # (SPEC §3.6, E16): the save is AUDITED BEFORE IT IS VISIBLE. The action row, with
    # every changed field from the stored document before and the validated document
    # after (secrets withheld, webhook URLs cut to scheme and host), is appended first;
    # a failed append answers 503 audit_unavailable and nothing is saved. The edit is
    # re-applied under the prefs lock to the freshest document, so a settings write
    # racing a source/rule/tuner/branding writer never restores a stale sibling block
    # (see ``audit.prefs_write``).
    def _apply(current: Preferences) -> Preferences:
        if (
            current.read_only_settings_mode
            and body.get("read_only_settings_mode") is not False
        ):
            raise HTTPException(status_code=403, detail="Settings are in read-only mode")
        # AFTER the read-only gate (that answer takes precedence) and BEFORE the merge:
        # the check must see the REQUEST BODY, because `_clamp_caps` repairs the merged
        # document before any `ge=` constraint can fire. See `_reject_out_of_range_caps`.
        _reject_out_of_range_caps(body)
        _reject_out_of_range_remember_me(body)
        # Round 14 (SPEC §4.10.19): a retired runbook key the body CHANGES
        # (``rag.use_runbooks``, ``playbooks.enabled``) is carried onto its successor
        # under ``runbooks`` before the merge; validation rewrites the retired key as a
        # read-only mirror, so without this the write would answer 200 and change nothing.
        mapped = map_retired_runbook_writes(body, current)
        merged = _deep_update(current.model_dump(mode="json"), mapped)
        # Demo Mode is managed ONLY by the /api/demo/* endpoints — never via this path.
        merged["demo"] = current.demo.model_dump(mode="json")
        try:
            return Preferences.model_validate(merged)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=422, detail=f"Invalid settings: {exc}") from exc

    # The legacy one-line summary keeps naming the top-level keys the body sent (never
    # their values, #10); the structured ``changes`` carry what actually changed.
    changed = sorted(str(k) for k in body.keys()) if isinstance(body, dict) else []
    body_sources = body.get("sources") if isinstance(body, dict) else None
    old_prefs, prefs = await audited_prefs_write(
        state,
        transform=_apply,
        actor=current_username(request) or "",
        context=audit_context(request),
        summary=("updated settings: " + ", ".join(changed))[:500] if changed else "updated settings",
        # A connector field its manifest marks secret is withheld whole, for the stored
        # sources and any the body brings.
        secret_fields=_source_secret_paths(
            [*state.prefs.sources, *(body_sources if isinstance(body_sources, list) else [])]
        ),
    )
    # #10 / G6 R5: record an immutable version snapshot for every rule this save CHANGED
    # (detection / correlation / case-automation) so DetectionRulesHome edits populate the
    # ledger + rollback UI. Best-effort; a versioning glitch never fails the save.
    await _record_settings_rule_versions(state, request, old_prefs, prefs)
    if prefs.setup_complete and prefs.polling_enabled and not prefs.caps.kill_switch:
        state.poller.start()
    return {"ok": True, "prefs": prefs.model_dump(mode="json")}


class CaseIdPreviewBody(BaseModel):
    template: str
    prefix: str = "CASE"
    seq_start: int = 1


@router.post("/settings/case-id/preview")
async def case_id_preview(
    body: CaseIdPreviewBody,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("settings", "manage")),
) -> dict[str, Any]:
    """Render 5 sample case numbers from a CANDIDATE template without persisting or
    consuming the live sequence. Returns ``{samples, valid, error}`` (F7 live
    preview). Gated by settings:manage."""
    from ..engine.case_id import preview_samples

    return preview_samples(
        body.template, prefix=body.prefix or "CASE", seq_start=int(body.seq_start), count=5
    )


@router.get("/settings/{section}")
async def get_settings_section(
    section: str,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("settings", "read")),
) -> dict[str, Any]:
    """Return a single Preferences subtree by key (e.g. ``rag``, ``notifications``),
    JSON-encoded. 404 for an unknown key. No secrets ever appear (Preferences carry
    only the non-secret tier). settings:read."""
    from .settings_schema import section_keys

    if section not in section_keys():
        raise HTTPException(status_code=404, detail=f"Unknown settings section: {section}")
    dumped = state.prefs.model_dump(mode="json")
    return {"section": section, "value": dumped.get(section)}


# --------------------------------------------------------------------------- #
# Chat (Surface 1 + Surface 2 follow-up — one engine)
# --------------------------------------------------------------------------- #
def _chat_history_http(exc: Exception) -> HTTPException:
    return HTTPException(
        status_code=503,
        detail={
            "code": "chat_history_unavailable",
            "message": str(exc) or "Chat history is temporarily unavailable.",
        },
    )


def _chat_conflict_http(code: str, message: str) -> HTTPException:
    return HTTPException(status_code=409, detail={"code": code, "message": message})


def _chat_request_fingerprint(body: ChatRequest) -> str:
    """Stable identity over caller-controlled inputs (never over generated ids).

    ``fingerprint_payload`` dumps the pre-revamp fields exactly as before and the
    revamp fields only when they differ from their defaults (``stream_mode`` never),
    so a pre-revamp body hashes byte-identically and one key is valid across
    ``/chat`` and ``/chat/stream`` (chat revamp SPEC §3.1)."""
    payload = body.fingerprint_payload()
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


class ChatConversationPage(BaseModel):
    """``GET /api/chat/conversations``: one page of the caller's conversation
    summaries. With ``?q=`` each row also carries ``match {message_id, snippet}``
    (rows of a plain listing omit it; the route serialises with
    ``response_model_exclude_unset`` so the wire shape is unchanged)."""

    conversations: list[ChatConversationSearchHit]
    # The retained (paginatable) count, kept for compatibility.
    total: int
    history_truncated: bool
    total_conversation_count: int
    oldest_retained_at: str | None = None
    limit: int
    offset: int
    # With ``?q=`` only (Round 12): the full-text search hit its read budget, so older
    # messages of some conversations were not searched.
    search_incomplete: bool = False


@router.get(
    "/chat/conversations",
    response_model=ChatConversationPage,
    response_model_exclude_unset=True,
)
async def list_chat_conversations(
    request: Request,
    state: AppState = Depends(get_state),
    limit: int = Query(default=30, ge=1, le=60),
    offset: int = Query(default=0, ge=0),
    q: str | None = Query(default=None, max_length=200),
    _=Depends(require_permission("cases", "read")),
) -> dict[str, Any]:
    """Workspace conversation summaries owned by this principal: pinned first, then
    newest first. ``limit`` goes to 60 so the <= 10 pinned conversations (exempt
    from the 50-conversation eviction) are never off the first page. With ``q`` the
    rows are the conversations whose title, messages or block titles contain it,
    each with a ``match {message_id, snippet}`` (chat revamp SPEC §7.5).

    Auth-disabled deployments use the same isolated ``default`` profile as user
    preferences. Case-scoped collaboration chat is intentionally not listed here.
    """
    try:
        if q and q.strip():
            page = await state.chat_conversations.search(
                current_username(request), q, limit=limit, offset=offset,
            )
        else:
            page = await state.chat_conversations.list_page(
                current_username(request), limit=limit, offset=offset,
            )
    except ChatHistoryUnavailable as exc:
        raise _chat_history_http(exc) from exc
    result = {
        "conversations": [item.model_dump(mode="json") for item in page.conversations],
        # ``total`` remains the retained/paginatable count for compatibility.
        "total": page.total,
        "history_truncated": page.history_truncated,
        "total_conversation_count": page.total_conversation_count,
        "oldest_retained_at": page.oldest_retained_at,
        "limit": limit,
        "offset": offset,
    }
    if q and q.strip():
        result["search_incomplete"] = bool(getattr(page, "search_incomplete", False))
    return result


@router.get(
    "/chat/conversations/{conversation_id}",
    response_model=ChatConversation,
    response_model_exclude_unset=True,
)
async def get_chat_conversation(
    conversation_id: str,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("cases", "read")),
) -> dict[str, Any]:
    """One owned Workspace conversation, including its bounded transcript."""
    try:
        conversation = await state.chat_conversations.get(
            current_username(request), conversation_id,
        )
    except ChatHistoryUnavailable as exc:
        raise _chat_history_http(exc) from exc
    if conversation is None:
        # Ownership is intentionally indistinguishable from absence.
        raise HTTPException(status_code=404, detail="conversation not found")
    return conversation.model_dump(mode="json")


@router.patch(
    "/chat/conversations/{conversation_id}",
    response_model=ChatConversation,
    response_model_exclude_unset=True,
)
async def update_chat_conversation(
    conversation_id: str,
    body: ChatConversationUpdateRequest,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("cases", "read")),
) -> dict[str, Any]:
    """Rename (bounded, single-line plain text) and/or pin one owned conversation
    (chat revamp SPEC §7.5). Pinning never changes ``updated_at``; an 11th pin is
    409 ``chat_pin_limit``."""
    user = current_username(request)
    try:
        conversation = await state.chat_conversations.update(
            user, conversation_id, title=body.title, pinned=body.pinned,
        )
    except ChatPinLimitReached as exc:
        raise _chat_conflict_http("chat_pin_limit", str(exc)) from exc
    except ChatHistoryUnavailable as exc:
        raise _chat_history_http(exc) from exc
    if conversation is None:
        raise HTTPException(status_code=404, detail="conversation not found")
    changes = [
        *(["renamed"] if body.title is not None else []),
        *(["pinned" if body.pinned else "unpinned"] if body.pinned is not None else []),
    ]
    await state.audit.record(
        action_type=ActionType.CONTEXT,
        surface="chat_history",
        actor=user or "default",
        result_summary=f"conversation {' and '.join(changes)}: {conversation.id}"[:500],
    )
    return conversation.model_dump(mode="json")


@router.delete("/chat/conversations/{conversation_id}")
async def delete_chat_conversation(
    conversation_id: str,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("cases", "read")),
) -> dict[str, Any]:
    """Delete one owned Workspace transcript; the append-only audit remains."""
    user = current_username(request)
    try:
        removed = await state.chat_conversations.delete(user, conversation_id)
    except ChatHistoryUnavailable as exc:
        raise _chat_history_http(exc) from exc
    if not removed:
        raise HTTPException(status_code=404, detail="conversation not found")
    await state.audit.record(
        action_type=ActionType.CONTEXT,
        surface="chat_history",
        actor=user,
        result_summary=f"conversation deleted: {str(conversation_id)[:100]}",
    )
    return {"ok": True, "id": conversation_id}


@router.post("/chat", response_model=ChatResponse)
async def chat(
    body: ChatRequest, request: Request, state: AppState = Depends(get_state),
    _=Depends(require_permission("cases", "read")),
) -> ChatResponse:
    """One chat turn, blocking (chat revamp SPEC §6): the same preflight, turn task
    and persistence as ``POST /api/chat/stream`` (``routes_chat.run_chat_turn``),
    awaited. Imported lazily: ``routes_chat`` imports this module."""
    from .routes_chat import run_chat_blocking

    return await run_chat_blocking(request, body, state)


# --------------------------------------------------------------------------- #
# Investigate (Surface 2)
# --------------------------------------------------------------------------- #
@router.post("/investigate")
async def investigate(
    body: InvestigateRequest, state: AppState = Depends(get_state),
    _=Depends(require_permission("cases", "reinvestigate")),
) -> dict[str, Any]:
    query_source = state.active_source_for_id(body.source_id)
    if body.source_id and query_source is None:
        raise HTTPException(
            status_code=400,
            detail="The selected source is not an enabled queryable pull source",
        )
    cluster, widest = await _cluster_for_request(state, body, query_source=query_source)
    if cluster is None:
        # NEUTRAL, specific detail so the FE shows an empty-state, not a scary error.
        detail = _no_events_detail(body, widest)
        raise HTTPException(status_code=400, detail=detail)
    case = await state.pipeline.investigate_cluster(
        cluster, body.source_surface, state.execution_prefs, query_source=query_source
    )
    return _case_view(case, state)


# --------------------------------------------------------------------------- #
# Per-log AI overview (Feature 2) — single-event, cost-gated, read-only
# --------------------------------------------------------------------------- #
class OverviewRequest(BaseModel):
    source: dict[str, Any] = Field(default_factory=dict)
    index: str | None = None
    id: str | None = None
    data_view: str | None = None


@router.post("/overview")
async def overview(
    body: OverviewRequest, state: AppState = Depends(get_state),
    _=Depends(require_permission("cases", "read")),
) -> dict[str, Any]:
    if not body.source:
        raise HTTPException(status_code=400, detail="No event source provided")
    return await state.overview_service.overview(
        body.source, state.execution_prefs,
        index=body.index, id=body.id, data_view=body.data_view,
    )


# --------------------------------------------------------------------------- #
# Model catalog (Feature 4) — for the settings per-role model pickers
# --------------------------------------------------------------------------- #
@router.get("/models")
async def models(state: AppState = Depends(get_state)) -> dict[str, Any]:
    grouped = models_by_provider()
    # Merge the operator's runtime-registered self-hosted / LiteLLM (OpenAI-compatible)
    # models so a locally-added model is selectable in the per-role picker, and expose a
    # ``base_urls`` map so the picker can thread each custom model's endpoint onto the
    # saved ModelConfig (the gateway also resolves it from the store as a fallback #10).
    # Best-effort: a store glitch never breaks the built-in picker. #9: ids are plain data.
    base_urls: dict[str, str] = {}
    catalog_rows: list[dict[str, Any]] = [
        {
            "id": str(row.get("id") or ""),
            "provider": str(row.get("provider") or ""),
            "capabilities": model_capabilities(str(row.get("id") or "")),
            "base_url": row.get("base_url"),
            "is_custom": False,
        }
        for row in model_catalog()
        if str(row.get("id") or "")
    ]
    try:
        for row in await state.custom_models.list_models():
            mid = str(row.get("id", ""))
            base = str(row.get("base_url", "") or "")
            if not mid or not base:
                continue
            bucket = grouped.setdefault(str(row.get("provider") or "openai_compatible"), [])
            if mid not in bucket:
                bucket.append(mid)
            base_urls[mid] = base
            catalog_rows.append({
                "id": mid,
                "provider": str(row.get("provider") or "openai_compatible"),
                "capabilities": ["chat"],
                "base_url": base,
                "is_custom": True,
            })
    except Exception:  # noqa: BLE001 — custom store advisory to the picker
        pass
    return {
        "providers": {p: sorted(set(m)) for p, m in grouped.items()},
        "base_urls": base_urls,
        "models": catalog_rows,
        "capabilities": {
            row["id"]: list(row["capabilities"])
            for row in catalog_rows
        },
        "role_capabilities": {
            "router": ["chat"],
            "investigator": ["chat"],
            "formatter": ["chat"],
            "standup": ["chat"],
            "chat": ["chat"],
            "overview": ["chat"],
            "embedding": ["embedding"],
        },
        "configured": state.secrets.configured_status(),
    }


# --------------------------------------------------------------------------- #
# Agent personas (multi-agent roster) + plain-text runbooks — read-only catalog
# for the settings/console surfaces. Selection itself is deterministic in code.
# --------------------------------------------------------------------------- #
@router.get("/personas")
async def personas(state: AppState = Depends(get_state)) -> dict[str, Any]:
    from ..agents.personas import all_personas

    return {
        "enabled": state.prefs.personas.enabled,
        "personas": [
            {
                "id": p.id,
                "label": p.label,
                "specialization": p.specialization,
                "focus_tools": list(p.focus_tools),
                "keywords": list(p.keywords),
            }
            for p in all_personas()
        ],
    }


# --------------------------------------------------------------------------- #
# Agent PROPOSALS (HITL — agent drafts, human approves/rejects)
# --------------------------------------------------------------------------- #
# ``_proposal_public`` lives in ``engine/views.py`` (chat revamp SPEC §5.3) and is
# re-exported at the top of this module under its historical name.


@router.get("/proposals")
async def list_proposals(
    status: str | None = None,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("proposals", "read")),
) -> dict[str, Any]:
    """List agent-drafted proposals (newest first). ``?status=pending`` filters to
    the review queue; omit for all. A proposal is a PENDING recommendation — nothing
    is live until it is explicitly approved.

    Opportunistically garbage-collects lapsed proposals first. A queue nobody can work
    (the deployment whose approvals were broken for its whole life) otherwise grows
    without bound and keeps rendering month-old recommendations as actionable. The
    sweep is bounded, writes nothing when nothing has lapsed, and is best-effort: the
    store's read-time projection already presents a lapsed row as ``expired``, so a
    failed sweep costs durability, never honesty.
    """
    try:
        swept = await state.proposals.sweep_expired()
    except Exception as exc:  # noqa: BLE001 — a read must never fail on housekeeping
        logger.warning("expired-proposal sweep failed: %s", exc)
        swept = []
    if swept:
        try:
            await state.audit.record(
                action_type=ActionType.PROPOSAL,
                surface="proposal",
                actor="system",
                result_summary=(
                    f"expired {len(swept)} pending proposals past expires_at: "
                    + ",".join(p.id for p in swept[:20])
                    + (",..." if len(swept) > 20 else "")
                ),
            )
        except Exception as exc:  # noqa: BLE001 — audit is best-effort for housekeeping
            logger.warning("expired-proposal sweep audit failed: %s", exc)
    proposals = await state.proposals.list(status=status)
    return {
        "proposals": [_proposal_public(p) for p in proposals],
        "count": len(proposals),
        "expired_swept": len(swept),
    }


def _decision_failure_detail(phase: str, proposal_id: str, action: str) -> str:
    """Truthful 503 text for a failed decision, by the phase that actually failed.

    The operator-visible message must never claim more or less than the code can
    prove. ``audit`` means this attempt stopped before its effect could run;
    ``effect``/``finalize`` mean a configuration change may already be live, so the
    message names exactly what to inspect instead of reporting a clean no-op.
    """
    evidence = f"proposal-decision:{proposal_id}:{action}"
    noun = "approval" if action == "approve" else "rejection"
    done = "approved" if action == "approve" else "rejected"
    if phase == "finalize":
        return (
            f"The {noun} was applied and audited, but the proposal could not be marked "
            f"{done} and is still shown as pending. Inspect audit event {evidence} and the "
            "affected configuration; retrying is safe — the effect is keyed by the proposal id "
            "and cannot be applied twice."
        )
    if phase == "effect":
        return (
            f"The {noun} decision was audited but applying it did not complete, so the "
            "configuration may be partially changed. Inspect the proposal's approval_error, "
            f"audit event {evidence}, and the affected configuration; retrying is safe — the "
            "effect is keyed by the proposal id and cannot be applied twice."
        )
    return (
        f"This {noun} attempt was not recorded in the append-only audit trail and therefore "
        f"applied no configuration change. The proposal is still pending; inspect audit event "
        f"{evidence} and the proposal's approval_error, then retry."
    )


@router.post("/proposals/{proposal_id}/approve")
async def approve_proposal(
    proposal_id: str,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("proposals", "approve")),
) -> dict[str, Any]:
    """Approve or acknowledge a pending proposal through its kind-specific path.

    suppression → materialise a ``SuppressionRule`` from the payload and append it to
    ``Preferences.suppression_rules`` via the settings write path so the cost gate
    picks it up LIVE. memory → append a human-injectable agent fact. tuning →
    revalidate and, where eligible, materialise the bounded change. ``automation_ack``
    records review only and never mutates configuration, Memory, suppression, or case
    state.

    The decision runs in four ordered phases — PREPARE (pure validation only),
    AUDIT (the strict ``event_id``-keyed decision record), EFFECT, FINALISE — so an
    operator who is told the approval failed can never find the configuration already
    changed by that attempt. Every phase is idempotent: the strict claim fixes actor
    and audit timestamp, ``record_strict`` deduplicates on ``event_id``, and every
    effect is keyed by proposal id, so a retry after any failure converges on exactly
    one applied change. 404 if missing; 409 if already decided/in progress, if the
    proposal has EXPIRED, or if its evidence basis can no longer be verified — the
    last two are refusals to act on stale reasoning and ask for a re-draft, and both
    happen before anything is audited or applied."""
    by = current_username(request)
    token = new_id("approval-")
    try:
        proposal, claim = await state.proposals.claim_approval(
            proposal_id, by=by, token=token
        )
    except Exception as exc:  # durability boundary: never run an effect without a claim
        logger.exception("Approval claim for proposal %s could not be persisted", proposal_id)
        raise HTTPException(status_code=503, detail="Could not persist the approval claim") from exc
    if claim == "missing" or proposal is None:
        raise HTTPException(status_code=404, detail="proposal not found")
    if claim == "expired":
        # Its evidence window closed. Refusing is the safe default: approving a
        # month-old recommendation against today's configuration is not.
        raise HTTPException(
            status_code=409,
            detail={
                "error": "proposal_expired",
                "proposal_id": proposal.id,
                "expires_at": proposal.expires_at,
                "redraft_required": True,
                "message": (
                    "This proposal expired and can no longer be approved. Reject it to "
                    "clear the queue; the drafter re-proposes from current evidence."
                ),
            },
        )
    if claim != "claimed":
        raise HTTPException(
            status_code=409,
            detail=f"proposal is {proposal.status}, not pending",
        )
    # The first durable claim owns attribution for the entire decision. A stale
    # lease may be resumed by another operator, but effects and retry-deduplicated
    # append-only evidence must remain byte-equivalent to the first attempt.
    decision_actor = (
        proposal.decision_actor
        if proposal.decision_actor is not None
        else (by or "").strip()
    )
    audit_actor = decision_actor or "analyst"

    # PREPARE validates purely, AUDIT records the decision, EFFECT applies it,
    # FINALISE closes the lease. ``phase`` names the boundary an exception crossed so
    # the 503 below can tell the operator what is actually true of their config.
    phase = "prepare"
    effect: Callable[[], Awaitable[None]] | None = None
    try:
        if proposal.kind == "suppression":
            payload = dict(proposal.payload or {})
            try:
                rule = SuppressionRule.model_validate({
                    "field": payload.get("field"),
                    "value": payload.get("value"),
                    "reason": payload.get("reason", ""),
                    "confidence": payload.get("confidence", proposal.confidence),
                    "rationale": payload.get("rationale", proposal.rationale),
                    "source_case_ids": payload.get("source_case_ids", proposal.source_case_ids),
                    "created_by": payload.get("created_by", "agent"),
                    "approval_proposal_id": proposal.id,
                    "expires_at": payload.get("expires_at", proposal.expires_at),
                    "enabled": payload.get("enabled", True),
                })
            except Exception as exc:  # noqa: BLE001 — normalise validation to HTTP 400 below
                raise ValueError(f"invalid suppression payload: {exc}") from exc
            # The proposal id is an additive idempotency key. A retry after an
            # ambiguous finalise observes the existing rule and performs no append.
            def _append_once(prefs: Preferences) -> Preferences:
                if any(
                    existing.approval_proposal_id == proposal.id
                    for existing in prefs.suppression_rules
                ):
                    return prefs
                return prefs.model_copy(update={
                    "suppression_rules": [*prefs.suppression_rules, rule],
                })

            async def _apply_suppression() -> None:
                await state.mutate_execution_prefs(_append_once)

            effect = _apply_suppression
        elif proposal.kind == "memory":
            payload = dict(proposal.payload or {})
            text = str(payload.get("text", "") or proposal.rationale).strip()
            if not text:
                raise ValueError("memory proposal has no text")

            async def _apply_memory() -> None:
                # Strict persistence: approval cannot succeed on a fail-soft KV write.
                # ``proposal_id`` is the idempotency key for a post-audit retry.
                await state.memory.add_approved_proposal_strict(
                    text,
                    proposal_id=proposal.id,
                    category=str(payload.get("category", "")),
                    tags=list(payload.get("tags", []) or []),
                    author=decision_actor,
                )

            effect = _apply_memory
        elif proposal.kind == "tuning":
            from ..engine.threshold_tuner import (
                commit_approved_tuning,
                materialize_approved_tuning,
            )

            payload = dict(proposal.payload or {})
            fingerprint = proposal.evidence_fingerprint
            # Pure revalidation BEFORE the decision record: an unknown action, an
            # out-of-policy step, an unverifiable evidence basis, or a recommendation
            # overtaken by a live change is refused without auditing an approval that
            # will never be applied. The commit below revalidates again against the
            # freshest preferences under its own lock.
            materialize_approved_tuning(
                state.execution_prefs,
                payload,
                proposal_id=proposal.id,
                allow_idempotent_replay=True,
                evidence_fingerprint_recorded=fingerprint,
            )

            async def _apply_tuning() -> None:
                record, created = await commit_approved_tuning(
                    state.execution_prefs,
                    payload,
                    proposal_id=proposal.id,
                    tuning_store=state.tuning_store,
                    write_prefs=state.update_execution_prefs,
                    mutate_prefs=state.mutate_execution_prefs,
                    evidence_fingerprint_recorded=fingerprint,
                )
                if record is not None and created:
                    await state.audit.record(
                        action_type=ActionType.TUNING,
                        surface="proposal",
                        actor=audit_actor,
                        result_summary=(
                            f"approved tuning proposal {proposal.id}: {record.target} "
                            f"{record.before}->{record.after} for {record.rule_id}"
                        ),
                    )

            effect = _apply_tuning
        elif proposal.kind == "automation_ack":
            # The status transition and audit are the complete effect.
            effect = None
        else:  # pragma: no cover — Literal-constrained, defensive
            raise ValueError(f"unknown proposal kind: {proposal.kind}")

        # The strict decision record comes FIRST so a failure here cannot leave a
        # silently applied configuration change behind. It is keyed by event_id and
        # its content is a pure function of the fixed claim, so the retry that
        # follows a failed effect or finalisation reuses this exact row.
        phase = "audit"
        await state.control_audit.record_strict(
            action_type=ActionType.PROPOSAL,
            event_id=f"proposal-decision:{proposal.id}:approve",
            ts=proposal.decision_audit_at,
            surface="proposal",
            actor=audit_actor,
            result_summary=(
                f"proposal_id={proposal.id} action=approve kind={proposal.kind} "
                "decision=authorized effect=pending finalization=pending"
            ),
        )
        phase = "effect"
        if effect is not None:
            await effect()
        phase = "finalize"
        updated = await state.proposals.finalize_approval(
            proposal_id, by=by, token=token
        )
        if updated is None:
            raise RuntimeError("approval lease was lost before finalisation")
    except Exception as exc:  # noqa: BLE001 — release the lease for a visible retry
        # Diagnosis must not depend on the proposal's approval_error field alone.
        logger.exception(
            "Proposal %s approval failed in the %s phase (kind=%s)",
            proposal_id, phase, proposal.kind,
        )
        try:
            await state.proposals.release_approval(
                proposal_id, token=token, error=str(exc)
            )
        except Exception:  # noqa: BLE001 — status remains applying; a stale lease is recoverable
            logger.exception("Could not release failed proposal approval %s", proposal_id)
        if isinstance(exc, ValueError):
            # A staleness refusal is NOT an ordinary failure: nothing is wrong with the
            # request, the recommendation itself is no longer safe to enact. Report it
            # as its own machine-readable outcome so an operator (and the UI) can tell
            # "re-draft this" apart from "this payload is malformed" or "the store is
            # down". ``tuning_evidence_code`` is read duck-typed so the route never
            # depends on the tuner module's exception class.
            code = getattr(exc, "tuning_evidence_code", None)
            if code:
                raise HTTPException(
                    status_code=409,
                    detail={
                        "error": "stale_proposal",
                        "code": str(code),
                        "proposal_id": proposal.id,
                        "redraft_required": True,
                        "message": str(exc),
                        "evidence": evidence_summary(proposal),
                    },
                ) from exc
            status = 409 if "stale" in str(exc).lower() else 400
            raise HTTPException(status_code=status, detail=str(exc)) from exc
        raise HTTPException(
            status_code=503,
            detail=_decision_failure_detail(phase, proposal.id, "approve"),
        ) from exc

    return {"ok": True, "proposal": _proposal_public(updated)}


async def _reject_one(
    state: AppState, proposal_id: str, *, by: str, reason: str = "",
) -> tuple[str, Proposal | None, str]:
    """Run ONE rejection through the durable decision boundary.

    The single and bulk endpoints share this exact body so bulk rejection is not a
    second, weaker path: strict CAS claim → strict ``event_id``-keyed append-only
    decision record → strict finalisation, unchanged. Rejection has no effect phase at
    all — preferences, Memory, suppression and case state are never touched.

    Returns ``(outcome, proposal, detail)`` instead of raising, so a batch can report
    per-item results without one bad item aborting the rest. ``outcome`` is one of
    ``rejected``, ``already_rejected``, ``missing``, ``conflict``, ``unavailable``
    (the claim could not be persisted — nothing was audited) or ``incomplete`` (the
    decision could not be durably completed).
    """
    token = new_id("rejection-")
    try:
        proposal, outcome = await state.proposals.claim_rejection(
            proposal_id, by=by, token=token, reason=reason,
        )
    except Exception as exc:  # noqa: BLE001 — never audit without a durable claim
        logger.exception("Rejection claim for proposal %s could not be persisted", proposal_id)
        return "unavailable", None, f"Could not persist the rejection claim: {exc}"
    if outcome == "missing" or proposal is None:
        return "missing", None, "proposal not found"
    if outcome != "claimed":
        if proposal.status == "rejected":
            # Idempotent: this proposal is already in the state the caller asked for
            # and its append-only decision row already exists.
            return "already_rejected", proposal, "proposal is already rejected"
        return "conflict", proposal, f"proposal is {proposal.status}, not pending"

    decision_actor = (
        proposal.decision_actor
        if proposal.decision_actor is not None
        else (by or "").strip()
    )
    fixed_reason = sanitize_decision_reason(proposal.decision_reason)
    phase = "audit"
    try:
        await state.control_audit.record_strict(
            action_type=ActionType.PROPOSAL,
            event_id=f"proposal-decision:{proposal.id}:reject",
            ts=proposal.decision_audit_at,
            surface="proposal",
            actor=decision_actor or "analyst",
            result_summary=(
                f"proposal_id={proposal.id} action=reject kind={proposal.kind} "
                "effect=none finalization=pending"
                + (f" reason={fixed_reason}" if fixed_reason else "")
            ),
        )
        phase = "finalize"
        updated = await state.proposals.finalize_rejection(
            proposal_id, by=by, token=token
        )
        if updated is None:
            raise RuntimeError("rejection lease was lost before finalisation")
    except Exception as exc:  # noqa: BLE001 — no unaudited success response
        logger.exception(
            "Proposal %s rejection failed in the %s phase (kind=%s)",
            proposal_id, phase, proposal.kind,
        )
        try:
            await state.proposals.release_approval(
                proposal_id, token=token, error=str(exc)
            )
        except Exception:  # noqa: BLE001 — status remains applying; a stale lease is recoverable
            logger.exception("Could not release failed proposal rejection %s", proposal_id)
        return "incomplete", proposal, (
            "Rejection could not be durably completed; the proposal is still pending and "
            "no configuration, Memory or case state was changed. Inspect audit event "
            f"proposal-decision:{proposal.id}:reject and the proposal's approval_error, "
            "then retry."
        )
    return "rejected", updated, ""


@router.post("/proposals/{proposal_id}/reject")
async def reject_proposal(
    proposal_id: str,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("proposals", "approve")),
) -> dict[str, Any]:
    """Reject a pending proposal through the same durable decision boundary.

    Rejection has no effect phase at all: preferences, Memory, suppression and case
    state are never touched, so the ordering is simply strict CAS claim → strict
    append-only decision record → strict finalisation. An EXPIRED proposal may still
    be rejected — retiring dead review work is how a queue is cleared and it changes
    nothing. 404 if missing; 409 if already decided/in progress.
    """
    by = current_username(request)
    outcome, proposal, detail = await _reject_one(state, proposal_id, by=by)
    if outcome == "unavailable":
        raise HTTPException(status_code=503, detail="Could not persist the rejection claim")
    if outcome == "missing":
        raise HTTPException(status_code=404, detail="proposal not found")
    if outcome in {"conflict", "already_rejected"}:
        raise HTTPException(
            status_code=409,
            detail=(
                f"proposal is {proposal.status}, not pending"
                if proposal is not None
                else detail
            ),
        )
    if outcome == "incomplete":
        raise HTTPException(status_code=503, detail=detail)
    return {"ok": True, "proposal": _proposal_public(proposal)}


class ProposalBulkRejectRequest(BaseModel):
    """Explicit ids plus one audited reason for clearing a review queue."""

    ids: list[str] = Field(default_factory=list)
    reason: str = ""


@router.post("/proposals/bulk-reject")
async def bulk_reject_proposals(
    body: ProposalBulkRejectRequest,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("proposals", "approve")),
) -> dict[str, Any]:
    """Reject many proposals in one audited request.

    A queue that accumulated for a deployment's whole life cannot realistically be
    cleared one HTTP request at a time, but convenience must not buy itself a hole in
    the append-only audit trail (#2). This therefore runs the SAME strict per-proposal
    decision path as :func:`reject_proposal` — one ``event_id``-keyed append-only
    decision record each — rather than a bulk state write with a single summary row.

    Consequences of that choice, all deliberate:

    * **Idempotent.** An already-rejected id reports ``already_rejected`` and writes
      nothing new; ``record_strict`` deduplicates on ``event_id`` anyway.
    * **Partial success is a first-class result.** One unusable id — missing, in
      flight, or a store hiccup — is reported in ``results`` and never aborts the
      batch, so an operator is never left guessing which half landed.
    * **Bounded.** At most :data:`BULK_DECISION_LIMIT` ids per request, deduplicated,
      because each one performs a durable write.

    Expired proposals are rejectable, which is what makes this the queue-clearing tool.
    """
    seen: set[str] = set()
    ids: list[str] = []
    for raw in body.ids or []:
        pid = str(raw or "").strip()
        if pid and pid not in seen:
            seen.add(pid)
            ids.append(pid)
    if not ids:
        raise HTTPException(status_code=400, detail="ids must contain at least one proposal id")
    if len(ids) > BULK_DECISION_LIMIT:
        raise HTTPException(
            status_code=400,
            detail=(
                f"at most {BULK_DECISION_LIMIT} proposals per bulk rejection "
                f"(received {len(ids)}); send the rest in a follow-up request"
            ),
        )
    reason = sanitize_decision_reason(body.reason)
    if not reason:
        raise HTTPException(
            status_code=400,
            detail=(
                "reason is required so the append-only audit row records why the queue "
                f"was cleared (max {MAX_DECISION_REASON_CHARS} characters)"
            ),
        )

    by = current_username(request)
    results: list[dict[str, Any]] = []
    for pid in ids:
        outcome, proposal, detail = await _reject_one(state, pid, by=by, reason=reason)
        row: dict[str, Any] = {
            "id": pid,
            "outcome": outcome,
            "ok": outcome in {"rejected", "already_rejected"},
        }
        if detail:
            row["detail"] = detail
        if proposal is not None:
            row["status"] = proposal.status
        results.append(row)

    rejected = [r["id"] for r in results if r["outcome"] == "rejected"]
    already = [r["id"] for r in results if r["outcome"] == "already_rejected"]
    failed = [r for r in results if not r["ok"]]
    try:
        await state.audit.record(
            action_type=ActionType.PROPOSAL,
            surface="proposal",
            actor=by or "analyst",
            result_summary=(
                f"bulk reject requested={len(ids)} rejected={len(rejected)} "
                f"already_rejected={len(already)} failed={len(failed)} reason={reason}"
            ),
        )
    except Exception as exc:  # noqa: BLE001 — the per-proposal strict rows are the record
        logger.warning("bulk rejection summary audit failed: %s", exc)

    return {
        "ok": not failed,
        "requested": len(ids),
        "rejected": rejected,
        "already_rejected": already,
        "failed": [r["id"] for r in failed],
        "results": results,
        "reason": reason,
    }


# --------------------------------------------------------------------------- #
# Retired procedure routes (Round 14 SPEC §4.10.16, D44, E14). For one release the
# reads stay as ALIASES over the runbook library in the old response shape, with
# ``Deprecation`` and ``Link`` headers, behind ``runbooks:read``; every write answers
# ``410 runbooks_moved``, because an old-shape write cannot be honoured without making
# unreviewed text live (#9). Nothing here reads the retired registry.
# --------------------------------------------------------------------------- #
def _legacy_markdown_body(content: str) -> str:
    """The exported Markdown without its front matter (the old ``body`` field)."""
    if content.startswith("---\n"):
        end = content.find("\n---\n", 4)
        if end != -1:
            return content[end + 5:].lstrip("\n")
    return content


def _legacy_playbook_item(
    runbook_id: str, version: Any, builtin: Any, *, include_content: bool,
) -> dict[str, Any]:
    """One Published runbook in the old procedure item shape (read-only)."""
    from ..engine.runbook_catalog import export_markdown

    defn = version.definition
    applies = defn.applies_when
    escalate = next((s.escalate_if for s in defn.steps if s.escalate_if), None)
    item: dict[str, Any] = {
        "id": runbook_id,
        "name": defn.title,
        "version": version.version,
        "description": defn.summary,
        "priority": defn.priority,
        "match": {
            "rule_ids": list(applies.rule_ids),
            "entity_types": [str(getattr(e, "value", e)) for e in applies.entity_types],
            "mitre": list(dict.fromkeys([*applies.mitre, *defn.mitre])),
            "min_event_count": applies.min_event_count or 0,
            "any_tags": list(applies.any_tags),
        },
        "suggested_tools": [],
        "rag_queries": list(defn.retrieval_queries),
        "escalate_if": escalate,
        "suggested_verdict_bias": None,
        "source_type": "bundled" if builtin is not None else "operator",
        "protected": builtin is not None,
        "editable": False,
        "file_name": builtin.file_name if builtin is not None else None,
    }
    if include_content:
        content = export_markdown(version)
        item["content"] = content
        item["body"] = _legacy_markdown_body(content)
    return item


async def _legacy_published(state: AppState) -> list[tuple[str, Any, Any, Any]]:
    from ..engine.runbook_catalog import published_versions
    from ..stores.runbook_library import RunbookStoreUnavailable

    try:
        return await published_versions(state.runbook_library)
    except RunbookStoreUnavailable as exc:
        raise HTTPException(status_code=503, detail={
            "code": "runbook_store_unavailable",
            "message": "Runbooks could not be read. Try again.",
        }) from exc


def _deprecated(response: Response) -> None:
    from ..engine.runbook_catalog import DEPRECATION_HEADERS

    for name, value in DEPRECATION_HEADERS.items():
        response.headers[name] = value


@router.get("/playbooks", deprecated=True)
async def playbooks(
    response: Response,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("runbooks", "read")),
) -> dict[str, Any]:
    """Deprecated alias: every Published runbook in the old procedure list shape. Use
    ``GET /api/runbooks``."""
    _deprecated(response)
    items = [
        _legacy_playbook_item(rid, version, builtin, include_content=False)
        for rid, version, builtin, _doc in await _legacy_published(state)
    ]
    cfg = getattr(state.execution_prefs, "runbooks", None)
    return {"enabled": bool(getattr(cfg, "enabled", True)), "count": len(items), "playbooks": items}


@router.get("/playbooks/coverage", deprecated=True)
async def playbooks_coverage(
    response: Response,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("runbooks", "read")),
) -> dict[str, Any]:
    """Deprecated alias: which runbook each stored case would match (the fallback does
    not count as coverage), over at most 20,000 cases. Use ``GET /api/runbooks/metrics``
    for runbook coverage."""
    from ..engine import runbook_runs
    from ..engine.runbook_match import match
    from ..stores.runbook_library import RunbookStoreUnavailable

    _deprecated(response)
    try:
        catalog = await runbook_runs.load_catalog(state)
    except RunbookStoreUnavailable as exc:
        raise HTTPException(status_code=503, detail={
            "code": "runbook_store_unavailable",
            "message": "Runbooks could not be read. Try again.",
        }) from exc
    prefs = state.execution_prefs
    offset = 0
    page_size = 500
    max_cases = 20_000
    scanned = covered = 0
    selected_counts: dict[str, int] = {}
    unmatched_rules: dict[str, int] = {}
    while scanned < max_cases:
        page, total = await state.cases.list(limit=page_size, offset=offset)
        if not page:
            break
        for case in page:
            result = match(runbook_runs.case_facts(case, prefs), catalog.matchable, fallback=False)
            scanned += 1
            if result.winner is not None:
                covered += 1
                selected_counts[result.winner.id] = selected_counts.get(result.winner.id, 0) + 1
            else:
                families = sorted({str(v).strip() for v in case.rule_ids if str(v).strip()}) or ["<no-rule-id>"]
                for family in families:
                    unmatched_rules[family] = unmatched_rules.get(family, 0) + 1
            if scanned >= max_cases:
                break
        offset += len(page)
        if offset >= total or len(page) < page_size:
            break
    return {
        "scanned_cases": scanned,
        "covered_cases": covered,
        "uncovered_cases": scanned - covered,
        "coverage_percent": round((covered / scanned) * 100, 1) if scanned else None,
        "scan_limit": max_cases,
        "truncated": scanned >= max_cases,
        "selected_playbooks": [
            {"playbook_id": key, "case_count": value}
            for key, value in sorted(selected_counts.items(), key=lambda item: (-item[1], item[0]))
        ],
        "unmatched_rule_families": [
            {"rule_id": key, "case_count": value}
            for key, value in sorted(unmatched_rules.items(), key=lambda item: (-item[1], item[0]))[:100]
        ],
    }


@router.get("/playbooks/selection/{case_id}", deprecated=True)
async def playbook_selection(
    case_id: str,
    response: Response,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("cases", "read")),
    __=Depends(require_permission("runbooks", "read")),
) -> dict[str, Any]:
    """Deprecated alias: the runbook on a case and why it was attached (the first run
    that is not abandoned). Use ``GET /api/cases/{case_id}/runbooks``."""
    from ..engine.runbook_match import describe_explanation
    from ..models import MatchExplanation

    _deprecated(response)
    case = await state.cases.get(case_id)
    runbook_id = ""
    reason = ""
    if case is not None:
        try:
            runs = (await state.runbook_runs.get(case_id)).runs
        except Exception:  # noqa: BLE001 (explainability is best-effort)
            runs = []
        run = next((r for r in runs if r.status != "abandoned"), None)
        if run is not None:
            runbook_id = run.runbook_id
            info = run.attached_reason or {}
            if run.attached_by in ("rule", "fallback") and "tier" in info and "matched" in info:
                try:
                    reason = describe_explanation(MatchExplanation.model_validate(info))
                except Exception:  # noqa: BLE001
                    reason = ""
            elif run.attached_actor:
                reason = f"Added by {run.attached_actor}"
        else:
            runbook_id = str(getattr(case, "playbook_id", "") or "")
    return {"case_id": case_id, "playbook_id": runbook_id, "reason": reason}


@router.get("/playbooks/{playbook_id}", deprecated=True)
async def playbook_detail(
    playbook_id: str,
    response: Response,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("runbooks", "read")),
) -> dict[str, Any]:
    """Deprecated alias: one Published runbook in the old procedure detail shape,
    ``content`` and ``body`` exported as Markdown. A retired bundled procedure id
    answers with the runbook that replaced it; an unknown id answers the old ``404``
    (``{"detail": "playbook not found"}``). Use ``GET /api/runbooks/{id}``."""
    from ..engine.runbook_model import LEGACY_BUNDLED_RUNBOOK_MAP

    _deprecated(response)
    wanted = {playbook_id, LEGACY_BUNDLED_RUNBOOK_MAP.get(playbook_id, playbook_id)}
    for rid, version, builtin, _doc in await _legacy_published(state):
        if rid in wanted:
            return _legacy_playbook_item(rid, version, builtin, include_content=True)
    from ..engine.runbook_catalog import DEPRECATION_HEADERS

    raise HTTPException(status_code=404, detail="playbook not found", headers=dict(DEPRECATION_HEADERS))


def _runbooks_moved() -> Any:
    from ..engine.runbook_catalog import runbooks_moved_response

    return runbooks_moved_response()


@router.post("/playbooks", deprecated=True, status_code=410)
async def playbooks_create(_=Depends(require_permission("runbooks", "manage"))) -> Any:
    """Retired write: ``410 runbooks_moved``. Create a runbook with ``POST /api/runbooks``."""
    return _runbooks_moved()


@router.post("/playbooks/reload", deprecated=True, status_code=410)
async def playbooks_reload(_=Depends(require_permission("runbooks", "manage"))) -> Any:
    """Retired write: ``410 runbooks_moved``. The runbook library needs no reload."""
    return _runbooks_moved()


@router.post("/playbooks/dry-run", deprecated=True, status_code=410)
async def playbooks_dry_run(_=Depends(require_permission("runbooks", "read"))) -> Any:
    """Retired: ``410 runbooks_moved``. Preview matching with ``POST
    /api/runbooks/match-preview``."""
    return _runbooks_moved()


@router.put("/playbooks/{playbook_id}", deprecated=True, status_code=410)
async def playbook_update(playbook_id: str, _=Depends(require_permission("runbooks", "manage"))) -> Any:
    """Retired write: ``410 runbooks_moved``. Edit a draft with ``PUT
    /api/runbooks/{id}/draft``."""
    del playbook_id
    return _runbooks_moved()


# --------------------------------------------------------------------------- #
# Metrics / analytics (deterministic aggregation over cases + the cost ledger)
# --------------------------------------------------------------------------- #
@router.get("/metrics")
async def metrics(window_hours: int = 24, state: AppState = Depends(get_state)) -> dict[str, Any]:
    # Round 12: exact store-wide headline counts (status / verdict / disposition
    # aggregates) beside figures over the SAME shared all-time case population the
    # posture rollups read, with a truncation marker for the latter. See
    # ``routes_metrics.legacy_metrics_payload``. An unreadable store is a 503.
    from . import routes_metrics

    return await routes_metrics.legacy_metrics_payload(state, window_hours)


@router.get("/feedback/stats")
async def feedback_stats_route(state: AppState = Depends(get_state)) -> dict[str, Any]:
    cases, _total = await state.cases.list(limit=2000)
    return feedback_stats(cases)


# --------------------------------------------------------------------------- #
# Demo Mode (Wave 5) — reversible, isolated synthetic showcase. Mutations use the
# dedicated ``demo:manage`` grant (built-in role behavior mirrors settings:manage).
# Enabling builds a SEPARATE in-memory store + a $0 deterministic mock LLM and
# seeds a backdated history; while active the READ endpoints serve the DEMO store
# (real cases hidden) and disable hard-deletes demo data so real state returns.
# --------------------------------------------------------------------------- #
class DemoEnableBody(BaseModel):
    mode: Literal["seeded", "live"] = "seeded"
    seed: int | None = None
    history_days: int | None = Field(default=None, ge=0, le=365)
    tick_seconds: float | None = Field(default=None, gt=0.0, le=60.0)
    tick_jitter: float | None = Field(default=None, ge=0.0, le=1.0)
    incident_rate: float | None = Field(default=None, ge=0.0, le=1.0)
    alert_interval_seconds: float | None = Field(default=None, gt=0.0, le=3600.0)
    event_rate_per_second: float | None = Field(default=None, ge=0.0, le=200.0)
    preseed_recent_minutes: int | None = Field(default=None, ge=0, le=120)
    preseed_case_count: int | None = Field(default=None, ge=0, le=20)
    preseed_event_count: int | None = Field(default=None, ge=0, le=2000)
    force_capabilities: bool | None = None


class DemoIncidentBody(BaseModel):
    scenario_id: str | None = Field(
        default=None, max_length=80, pattern=r"^[a-z0-9_-]+$",
    )


@router.get("/demo/status")
async def demo_status(
    state: AppState = Depends(get_state),
    _read=Depends(require_permission("demo", "read")),
) -> dict[str, Any]:
    return await state.demo_status()


@router.post("/demo/enable")
async def demo_enable(
    request: Request,
    body: DemoEnableBody,
    state: AppState = Depends(get_state),
    _manage=Depends(require_permission("demo", "manage")),
) -> dict[str, Any]:
    if state.prefs.read_only_settings_mode:
        raise HTTPException(status_code=403, detail="settings are read-only")
    mode = body.mode
    status = await state.enable_demo(
        mode=mode, seed=body.seed, history_days=body.history_days,
        tick_seconds=body.tick_seconds, tick_jitter=body.tick_jitter,
        incident_rate=body.incident_rate,
        alert_interval_seconds=body.alert_interval_seconds,
        event_rate_per_second=body.event_rate_per_second,
        preseed_recent_minutes=body.preseed_recent_minutes,
        preseed_case_count=body.preseed_case_count,
        preseed_event_count=body.preseed_event_count,
        force_capabilities=body.force_capabilities,
    )
    # Audit the mutation on the REAL audit log (demo data itself remains isolated).
    await state.real_audit.record(
        action_type=ActionType.DECISION,
        surface="demo",
        actor=current_username(request) or "operator",
        result_summary=f"demo enabled mode={mode} run_id={status.get('run_id')}",
    )
    return status


@router.post("/demo/incident")
async def demo_incident(
    request: Request,
    body: DemoIncidentBody | None = None,
    state: AppState = Depends(get_state),
    _manage=Depends(require_permission("demo", "manage")),
) -> dict[str, Any]:
    """Trigger one coherent, cooldown-aware attack in the isolated demo stack.

    Splunk/QRadar/Wazuh contribute source-native alerts and syslog contributes raw
    RFC 5424 telemetry that Agentic SOC detects. The action requires ``demo:manage`` and is
    recorded in the REAL append-only audit trail; generated data/cases/cost stay demo-only.
    """
    if not state.demo_active:
        raise HTTPException(status_code=409, detail="Demo mode is not active")
    scenario_id = body.scenario_id if body else None
    result = await state.trigger_demo_incident(scenario_id)
    await state.real_audit.record(
        action_type=ActionType.DECISION,
        surface="demo",
        actor=current_username(request) or "operator",
        result_summary=(
            f"demo incident trigger triggered={bool(result.get('triggered'))} "
            f"scenario_id={result.get('scenario_id') or scenario_id or ''} "
            f"reason={result.get('reason') or ''}"
        ),
    )
    return result


@router.post("/demo/reset")
async def demo_reset(
    request: Request,
    state: AppState = Depends(get_state),
    _manage=Depends(require_permission("demo", "manage")),
) -> dict[str, Any]:
    status = await state.reset_demo()
    await state.real_audit.record(
        action_type=ActionType.DECISION,
        surface="demo",
        actor=current_username(request) or "operator",
        result_summary=f"demo reset run_id={status.get('run_id')}",
    )
    return status


@router.post("/demo/disable")
async def demo_disable(
    request: Request,
    state: AppState = Depends(get_state),
    _manage=Depends(require_permission("demo", "manage")),
) -> dict[str, Any]:
    before = await state.demo_status()
    status = await state.disable_demo()
    await state.real_audit.record(
        action_type=ActionType.DECISION,
        surface="demo",
        actor=current_username(request) or "operator",
        result_summary=f"demo disabled run_id={before.get('run_id')}",
    )
    return status


# --------------------------------------------------------------------------- #
# Auth (Wave 2; OPTIONAL — the gate is a no-op when auth is disabled). The
# no-auth "old version" remains the default and fully available.
# --------------------------------------------------------------------------- #
class LoginBody(BaseModel):
    username: str
    password: str
    # Round 12: "Remember me" (additive; the proxies forward arbitrary JSON). The
    # server decides eligibility (``_remember_decision``) — a request is never a grant.
    remember: bool = False


def _resolved_role(state: AppState, user) -> str:
    """The role to surface to the UI. When RBAC is OFF (or auth is the legacy env
    single-admin), an authenticated principal is effectively super_admin — report
    that so the webui unlocks every surface, matching the server-side back-compat."""
    rbac = getattr(state.prefs, "rbac", None)
    if not getattr(rbac, "enabled", False):
        return UserRole.SUPER_ADMIN.value
    return getattr(user, "role", "") or state.prefs.rbac.default_role


def _session_policy(state: AppState):
    """The live session/token policy (idle/absolute/window + notify toggles)."""
    return getattr(state.prefs, "session_policy", None)


# --------------------------------------------------------------------------- #
# Remember me (Round 12, SPEC D14). One cookie helper replaces the five copies:
# a REMEMBERED sign-in gets a persistent cookie (Max-Age = the policy duration, the
# JWT ``exp`` matches); every other sign-in gets a browser-session cookie (no
# Max-Age) bounded by the server's idle/absolute limits. The cookie NAME is an
# existing wire identifier and is unchanged (AGENTS.md naming contract).
# --------------------------------------------------------------------------- #
_SESSION_COOKIE = "tlsoc_token"

# Revocations this session's own user asked for on this device (logout, "Sign out
# this device"): /auth/me reports no reason for them.
_DELIBERATE_SIGNOUTS = frozenset({"logout", "self_signout"})

# Why a remember request was refused (or ``ok`` / ``not_requested``). Closed set.
REMEMBER_REASONS = ("ok", "not_requested", "disabled", "role_excluded", "insecure_transport")


def _set_session_cookie(
    response: Response, state: AppState, token: str, *, remember_seconds: int = 0
) -> None:
    """Set the session cookie. ``remember_seconds > 0`` makes it persistent."""
    kwargs: dict[str, Any] = {
        "httponly": True,
        "samesite": "lax",
        "secure": bool(state.secrets.auth_cookie_secure),
        "path": "/",
    }
    if remember_seconds > 0:
        kwargs["max_age"] = int(remember_seconds)
    response.set_cookie(_SESSION_COOKIE, token, **kwargs)


def _clear_session_cookie(response: Response, state: AppState) -> None:
    """Clear the session cookie with the SAME attributes it was set with."""
    response.delete_cookie(
        _SESSION_COOKIE,
        path="/",
        samesite="lax",
        secure=bool(state.secrets.auth_cookie_secure),
        httponly=True,
    )


def _host_is_loopback(host: str) -> bool:
    """Whether a ``Host``-style value (optionally with a port) names this machine."""
    import ipaddress

    value = (host or "").strip().lower()
    if not value:
        return False
    if value.startswith("["):  # [::1]:8080
        end = value.find("]")
        value = value[1:end] if end > 0 else value[1:]
    elif value.count(":") == 1:  # host:port (a bare IPv6 address has several colons)
        value = value.split(":", 1)[0]
    value = value.rstrip(".")
    if value == "localhost" or value.endswith(".localhost"):
        return True
    try:
        return ipaddress.ip_address(value).is_loopback
    except ValueError:
        return False


# Headers a reverse proxy adds when it forwards a request. Their presence means the
# request did not come straight from a browser on this machine, whatever ``Host`` says.
_FORWARDING_HEADERS = (
    "forwarded",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-proto",
    "x-real-ip",
)


def _peer_is_loopback(request: Request) -> bool:
    import ipaddress

    client = getattr(request, "client", None)
    host = str(getattr(client, "host", "") or "").strip().lower()
    if not host:
        return False
    if host.startswith("[") and host.endswith("]"):
        host = host[1:-1]
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _request_is_loopback(request: Request | None) -> bool:
    """True only for a DIRECT local request: the TCP peer is a loopback address, the
    ``Host`` header names this machine, and no reverse-proxy forwarding header is
    present. A proxied request — even one whose ``Host`` was rewritten to
    ``127.0.0.1`` by a proxy on the same host — never counts, because the browser
    behind the proxy may be anywhere on the network (OWASP ASVS 3.3.1). The
    development server's proxy (``./scripts/run-demo.sh``) forwards without these
    headers, so a browser on the same machine keeps Remember me there."""
    if request is None:
        return False
    if any(request.headers.get(name) for name in _FORWARDING_HEADERS):
        return False
    if not _peer_is_loopback(request):
        return False
    return _host_is_loopback(request.headers.get("host") or (request.url.hostname or ""))


def _remember_insecure(state: AppState, request: Request | None) -> bool:
    """Whether a persistent cookie would cross plain HTTP to a network origin: the
    cookie is not ``Secure`` (``AUTH_COOKIE_SECURE`` off) and the request is not a
    direct local one (see :func:`_request_is_loopback`). OWASP ASVS 3.3.1."""
    if bool(getattr(state.secrets, "auth_cookie_secure", False)):
        return False
    return not _request_is_loopback(request)


def _remember_policy(state: AppState):
    return getattr(_session_policy(state), "remember_me", None)


def _secure_cookies_configured(state: AppState) -> bool:
    """Whether ``AUTH_COOKIE_SECURE`` was set explicitly (environment or ``.env``)
    rather than left at its ``false`` default. The Session policy editor uses it to
    say what is true ("AUTH_COOKIE_SECURE=false" versus "not set"); it describes the
    shape of the configuration, never a secret value."""
    fields_set = getattr(state.secrets, "model_fields_set", None) or set()
    return "auth_cookie_secure" in fields_set


def _remember_me_status(state: AppState, request: Request | None) -> dict[str, Any]:
    """The PUBLIC ``/setup/status`` ``remember_me`` block.

    Non-secret by construction: an on/off flag, the lifetime a new remembered
    sign-in gets (the policy duration capped by the absolute lifetime), whether THIS
    request's transport would refuse it, whether the session cookie is marked
    ``Secure`` (observable on every ``Set-Cookie`` anyway — lets the sign-in page and
    the Session policy editor tell "plain HTTP" from "HTTPS without secure cookies"),
    whether ``AUTH_COOKIE_SECURE`` was set explicitly or left at its default
    (``secure_cookies_configured``, a boolean about the configuration's shape),
    how long a sign-in WITHOUT Remember me lasts (the token lifetime,
    ``AUTH_TOKEN_HOURS``), and ``idle_seconds``: how long a remembered device may go
    unused before it is signed out (0 when no inactivity limit is shorter than the
    remembered lifetime), so the page never promises more than the server keeps."""
    rm = _remember_policy(state)
    enabled = bool(getattr(rm, "enabled", False))
    duration = remember_window_seconds(_session_policy(state))
    if not duration:
        duration = int(getattr(rm, "duration_seconds", 0) or 0)
    idle_seconds = remember_idle_window_seconds(_session_policy(state))
    insecure_blocked = bool(
        enabled
        and not bool(getattr(rm, "allow_insecure_http", False))
        and _remember_insecure(state, request)
    )
    standard = int(getattr(getattr(state, "auth", None), "token_seconds", 0) or 0)
    return {
        "enabled": enabled,
        "duration_seconds": duration,
        "idle_seconds": idle_seconds,
        "insecure_blocked": insecure_blocked,
        "secure_cookies": bool(getattr(state.secrets, "auth_cookie_secure", False)),
        "secure_cookies_configured": _secure_cookies_configured(state),
        "standard_session_seconds": standard,
    }


def _remember_decision(
    state: AppState, request: Request | None, user: Any, requested: bool
) -> tuple[int, str]:
    """Server-side "Remember me" eligibility: ``(remember_seconds, reason)``.

    ``remember_seconds`` is the remembered lifetime when granted (the policy
    duration, capped by the standard absolute lifetime), else 0. Reasons, in
    precedence order: ``not_requested``, ``disabled`` (policy off),
    ``role_excluded`` (the account's stored role OR its effective role — every
    principal is effectively ``super_admin`` while RBAC is off — is excluded), and
    ``insecure_transport`` (see :func:`_remember_insecure`, unless the admin allowed
    plain HTTP). ``ok`` when granted. MFA and step-up are never affected. The same
    exclusion is re-checked on every request (``deps.live_session_limits``)."""
    if not requested:
        return (0, "not_requested")
    rm = _remember_policy(state)
    if rm is None or not bool(getattr(rm, "enabled", False)):
        return (0, "disabled")
    excluded = {
        str(r).strip().lower() for r in (getattr(rm, "excluded_roles", None) or []) if str(r).strip()
    }
    if excluded:
        roles = set(effective_roles(state.prefs, getattr(user, "role", "")))
        roles.add(str(_resolved_role(state, user) or "").strip().lower())
        if roles & excluded:
            return (0, "role_excluded")
    if not bool(getattr(rm, "allow_insecure_http", False)) and _remember_insecure(state, request):
        return (0, "insecure_transport")
    duration = min(REMEMBER_MAX_SECONDS, remember_window_seconds(_session_policy(state)))
    if duration <= 0:
        return (0, "disabled")
    return (duration, "ok")


def _duration_label(seconds: int) -> str:
    """A compact audit label for a lifetime: ``24h`` / ``90m``."""
    seconds = int(seconds or 0)
    if seconds > 0 and seconds % 3600 == 0:
        return f"{seconds // 3600}h"
    return f"{max(1, round(seconds / 60))}m"


def _token_expires_iso(state: AppState, token: str) -> str:
    """The ISO ``exp`` of a token this server just minted ("" when unknown)."""
    try:
        exp = int((state.auth.claims_of(token) or {}).get("exp", 0) or 0)
    except (TypeError, ValueError):
        return ""
    if exp <= 0:
        return ""
    from datetime import datetime, timezone

    try:
        return datetime.fromtimestamp(exp, tz=timezone.utc).isoformat()
    except (OverflowError, OSError, ValueError):
        return ""


def _remember_fields(
    state: AppState, token: str, remember_seconds: int, reason: str
) -> dict[str, Any]:
    """The additive ``remembered`` / ``remember_reason`` / ``session_expires_at``
    fields every session-minting response carries."""
    return {
        "remembered": remember_seconds > 0,
        "remember_reason": reason if reason in REMEMBER_REASONS else "disabled",
        "session_expires_at": _token_expires_iso(state, token),
    }


# --------------------------------------------------------------------------- #
# Identity audit rows (Round 14 SPEC §4.5.3, §4.5.4). Sign-in, sign-out, MFA and
# session events are recorded BEST-EFFORT WITH A SIGNAL with the structured fields
# (action, outcome, actor type, client, session reference, role at the time, request
# id): an audit outage must never stop a person signing in, signing out or ending a
# session, and a dropped row is logged at error level and counted
# (``app.audit.identity``). Every change to an account, a role or the settings is
# instead AUDIT-FIRST (``audited_write``): no change without its row.
# --------------------------------------------------------------------------- #
def _session_summary(event: str, sid: str, detail: str) -> str:
    """The session row's one-line summary, in the form older rows used
    (``session_create sid=1a2b3c4d… detail``), so existing readers keep working."""
    return f"{event} sid={_sid_tag(sid)} {detail}".strip()


def _user_target(username: str, label: str | None = None) -> dict[str, str] | None:
    name = str(username or "").strip()
    if not name:
        return None
    return {"type": "user", "id": name, "label": str(label or name)}


async def _patch_user_or_404(state: AppState, username: str, **fields: Any) -> Any:
    """The store write of an audited account change: patch ONLY the named fields
    under the user store's own compare-and-swap (never save a copy read before the
    action row was appended, which would revert whatever an administrator saved to
    the account meanwhile). An account deleted in that window answers ``404 user not
    found``, so ``audited_write`` records the paired failure row instead of a success
    that never happened."""
    updated = await state.users.update(username, **fields)
    if updated is None:
        raise HTTPException(status_code=404, detail="user not found")
    return updated


async def _record_identity_event(
    state: AppState,
    request: Request,
    *,
    action: str,
    actor: str,
    summary: str,
    outcome: str = "success",
    surface: str = "auth",
    actor_type: str = "human",
    user: Any = None,
    token: str | None = None,
    sid: str | None = None,
    target: Any = None,
    tool_input: Any = None,
    from_request: bool = True,
) -> None:
    """Append one identity row to the real audit log (never the Demo one), best effort
    with a signal (:func:`app.audit.identity.record_identity_event`): a failure is
    logged, counted and never reaches the caller. ``user``/``token``/``sid`` name the
    principal and session the row is about when they are not the request's own (a
    sign-in that has just minted its session). ``from_request=False`` on every row
    written before its actor has signed in: the cookie or bearer token the request
    happens to carry (another account's, in the same browser) is never read."""
    await record_identity_event(
        state, request, action=action, actor=actor, summary=summary, outcome=outcome,
        surface=surface, actor_type=actor_type, user=user, token=token, sid=sid,
        target=target, tool_input=tool_input, from_request=from_request,
    )


def _session_tool_input(state: AppState, sid: str | None, **extra: Any) -> dict[str, Any] | None:
    """``{"session": <reference of the session acted on>, ...}`` for a session row
    whose subject is not the request's own session (a revocation)."""
    auth = getattr(state, "auth", None)
    ref_of = getattr(auth, "session_ref", None)
    ref = ref_of(sid) if callable(ref_of) and sid else None
    out: dict[str, Any] = {k: v for k, v in extra.items() if v is not None}
    if ref:
        out["session"] = ref
    return out or None


async def _register_session(
    state: AppState, request: Request, token: str, *, mfa_method: str = "",
    refresh_hash: str = "", remember_seconds: int = 0,
) -> str:
    """Session-create HOOK (Wave 3) — called at EVERY cookie-set site (login,
    mfa/verify, sso/callback). Decodes the freshly-minted token to read its ``sid``/
    ``tv``, records a Session row with PLAIN request metadata (ip + best-effort geo +
    parsed UA; #9), audits the create (#2), and best-effort fires a
    ``notify_on_new_device`` notification. Returns the sid ("" when no sid claim /
    auth off). NEVER raises into the login flow."""
    sessions = getattr(state, "sessions", None)
    auth = getattr(state, "auth", None)
    if sessions is None or auth is None:
        return ""
    try:
        claims = auth.claims_of(token) or {}
        sid = str(claims.get("sid") or "")
        if not sid:
            return ""
        username = str(claims.get("sub") or "")
        tv = int(claims.get("tv", 0) or 0)
        policy = _session_policy(state)
        limits = limits_for_username(state, username)
        remembered = int(remember_seconds or 0) > 0
        if remembered:
            # Stamp the REMEMBERED limits on the row (display + prune); the live
            # policy stays authoritative in is_active().
            absolute = int(remember_seconds)
            idle = limits.remember_idle if 0 < limits.remember_idle <= absolute else absolute
        else:
            idle, absolute = limits.idle, limits.absolute
        meta = session_metadata(request)
        await sessions.create(
            sid=sid, username=username, token_version=tv,
            refresh_hash=refresh_hash or "",
            idle_timeout=idle, absolute_lifetime=absolute,
            mfa_method=mfa_method or "",
            remember=remembered,
            remember_seconds=int(remember_seconds or 0) if remembered else 0,
            token_expires_at=_token_expires_iso(state, token),
            **meta,
        )
        await _record_identity_event(
            state, request, action="session.created", actor=username, surface="session",
            token=token, user=auth.principal(username),
            summary=_session_summary(
                "session_create", sid,
                (
                    f"new session ({meta.get('client_type', '') or 'unknown'} "
                    f"{meta.get('ua_browser', '')}/{meta.get('ua_os', '')})"
                    + (f" remembered {_duration_label(remember_seconds)}" if remembered else "")
                ).strip(),
            ),
            target=_user_target(username),
            tool_input={"remembered": remembered, "mfa_method": mfa_method or "password"},
            from_request=False,
        )
        # Best-effort new-device notification (a first session for this UA/device).
        try:
            if bool(getattr(policy, "notify_on_new_device", False)):
                await _notify_session_event(state, username, "new_device", meta)
        except Exception:  # noqa: BLE001
            pass
        return sid
    except Exception:  # noqa: BLE001 — a session-record failure never blocks login
        return ""


async def _notify_session_event(state: AppState, username: str, kind: str,
                                meta: dict[str, str]) -> None:
    """Best-effort operator notification for a session lifecycle event (new device /
    termination). Reuses the existing NotificationService.dispatch with a synthetic
    'case' payload. Fire-and-forget; never raises."""
    notifier = getattr(state, "notifications", None)
    if notifier is None:
        return
    label = "New device sign-in" if kind == "new_device" else "Session terminated"
    payload = {
        "case_id": f"session-{kind}",
        "cluster_signature": f"session:{kind}:{username}",
        "title": f"{label} for {username}",
        "entity": {"type": "user", "value": username},
        "verdict": "NEEDS_HUMAN",
        "status": "needs_human",
        "risk_score": 0.0,
        "summary": (
            f"{label} for account '{username}' from "
            f"{meta.get('ip', '') or 'unknown IP'} "
            f"({meta.get('ua_browser', '')}/{meta.get('ua_os', '')})."
        ),
        "source_name": "Session security",
    }
    try:
        await notifier.dispatch(payload, "manual", check_triggers=False)
    except Exception:  # noqa: BLE001
        pass


@router.post("/auth/login")
async def auth_login(
    body: LoginBody, request: Request, response: Response,
    state: AppState = Depends(get_state),
) -> dict[str, Any]:
    auth = state.auth
    if not auth.is_enabled:
        raise HTTPException(status_code=400, detail="authentication is disabled")
    # Constant-cost credential check (no token yet: the lifetime depends on the
    # Remember-me decision below, which needs the verified principal's role).
    user = auth.principal(body.username) if auth.check_password(
        body.username, body.password
    ) else None
    if user is None:
        await _record_identity_event(
            state, request, action="auth.login_failed", outcome="failure",
            actor=body.username or "", summary="login failed", from_request=False,
        )
        raise HTTPException(status_code=401, detail="invalid credentials")
    # --- MFA phase 1 (Wave 2 / F3): the password is correct, but the user has MFA
    # enabled (or its role is enforced). Do NOT mint a session cookie/token here —
    # return a SHORT-LIVED pending token the client exchanges at /auth/mfa/verify
    # with a TOTP/recovery code. A user with mfa_enabled=False is UNAFFECTED.
    # Round 12: the user's Remember-me REQUEST rides in the SIGNED pending token
    # (``rm``); eligibility is decided when the session is minted. Remember me never
    # skips the second factor. ---
    if auth.requires_mfa(user.username):
        # --- Mandated-enrollment phase 1 (additive): the account is REQUIRED to use
        # MFA (per-user ``mfa_required`` mandate or role enforce_for_roles) but has
        # not ENROLLED yet, so a code challenge is impossible. Return the SAME
        # short-lived pending token plus ``mfa_enrollment_required`` — the client
        # completes enrollment at /auth/mfa/enroll-setup + /auth/mfa/enroll-confirm
        # (which then mints the full session). No cookie/session here either. ---
        if not auth.mfa_enabled(user.username):
            await _record_identity_event(
                state, request, action="auth.mfa_challenged", actor=user.username,
                user=user, summary="password ok; mfa enrollment required",
                target=_user_target(user.username),
                tool_input={"enrollment_required": True}, from_request=False,
            )
            return {
                "requires_mfa": True,
                "mfa_enrollment_required": True,
                "pending_token": auth.begin_mfa(user.username, remember=body.remember),
            }
        await _record_identity_event(
            state, request, action="auth.mfa_challenged", actor=user.username,
            user=user, summary="password ok; mfa challenge issued",
            target=_user_target(user.username), from_request=False,
        )
        return {
            "requires_mfa": True,
            "pending_token": auth.begin_mfa(user.username, remember=body.remember),
        }
    remember_seconds, remember_reason = _remember_decision(
        state, request, user, body.remember
    )
    minted = auth.mint_session(user.username, remember_seconds=remember_seconds)
    if minted is None:  # pragma: no cover — the principal was verified above
        raise HTTPException(status_code=401, detail="invalid credentials")
    token, _minted_user = minted
    # Best-effort: record the login timestamp (multi-user store only).
    try:
        await state.users.update(user.username, last_login_at=iso_now())
    except Exception:  # noqa: BLE001
        pass
    await _record_identity_event(
        state, request, action="auth.login", actor=user.username, user=user, token=token,
        summary=(
            f"login ok (remembered {_duration_label(remember_seconds)})"
            if remember_seconds > 0 else "login ok"
        ),
        target=_user_target(user.username),
        tool_input={"method": "password", "remembered": remember_seconds > 0},
        from_request=False,
    )
    # Wave 3: register the session (sid/tv from the token) with request metadata.
    await _register_session(
        state, request, token, mfa_method="password", remember_seconds=remember_seconds
    )
    _set_session_cookie(response, state, token, remember_seconds=remember_seconds)
    return {
        "token": token,
        "user": {
            "username": user.username,
            "role": _resolved_role(state, user),
            "must_change_password": bool(user.must_change_password),
            "mfa_enabled": bool(getattr(user, "mfa_enabled", False)),
        },
        **_remember_fields(state, token, remember_seconds, remember_reason),
    }


def _object_scoped_for(state: AppState, user: Any) -> bool:
    """Does row-level (object) data scope apply to ``user``'s case reads? The one rule
    the chat starters and the metrics routes use; an unreadable configuration counts
    as scoped (fail closed)."""
    from ..engine.chat_starters import object_scoped

    role = getattr(user, "role", "") if user is not None else ""
    try:
        return bool(object_scoped(state, str(getattr(role, "value", role) or "")))
    except Exception:  # noqa: BLE001 -- fail closed
        return True


@router.get("/auth/me")
async def auth_me(
    request: Request, response: Response, state: AppState = Depends(get_state)
) -> dict[str, Any]:
    """The session state the console boots from (PUBLIC).

    Round 12: REGISTRY-AWARE. Beyond the JWT signature/``exp``/active-user check it
    runs the same session-registry evaluation as every protected route (revocation,
    per-user token version, idle and absolute limits — standard or remembered). When
    the session has ended it answers ``authenticated: false`` with a ``reason``
    (``revoked`` | ``idle_expired`` | ``absolute_expired`` | ``tv_mismatch``) and
    clears the cookie, so the console lands on the sign-in page instead of a shell
    where every call 401s. A session-store outage keeps trusting the JWT (as every
    protected route does). A live session carries an additive ``session`` summary
    ``{remember, expires_at, idle_expires_at}``.

    Round 14 (SPEC §4.4.5, D16): a signed-in answer also carries ``object_scoped``,
    true when row-level (object) data scope applies to the viewer's case reads (the
    rule the chat starters use, ``chat_starters.object_scoped``, failing closed), so
    the Console hides case-derived dashboard panels instead of showing aggregates the
    viewer could not read row by row. With sign-in off the answer is unchanged (no
    viewer role, so no row scope: an absent ``object_scoped`` reads as false)."""
    auth = state.auth
    if not auth.is_enabled:
        return {"authenticated": True, "auth_enabled": False, "user": None}
    cookie_token = request.cookies.get(_SESSION_COOKIE)
    token = cookie_token or _bearer(request)
    user = auth.verify(token) if token else None

    def _ended(reason: str | None, lifetime: int | None = None,
               remembered: bool | None = None) -> dict[str, Any]:
        if cookie_token:
            _clear_session_cookie(response, state)
        out: dict[str, Any] = {"authenticated": False, "auth_enabled": True, "user": None}
        if reason:
            out["reason"] = reason
        if lifetime:
            out["lifetime_seconds"] = int(lifetime)
        if remembered is not None:
            out["remembered"] = bool(remembered)
        return out

    if user is None:
        if not token:
            return {"authenticated": False, "auth_enabled": True, "user": None}
        expired = auth.expired_session_claims(token)
        if expired is not None:
            # A token this server signed whose own lifetime ran out: the session
            # ended at its absolute limit. The reason is reported (with the lifetime
            # for API readers); the Console never states how long the session lasted.
            try:
                lifetime = int(expired.get("exp", 0)) - int(expired.get("iat", 0))
            except (TypeError, ValueError):
                lifetime = 0
            return _ended("absolute_expired", lifetime if lifetime > 0 else None,
                          expired.get("rm") is True)
        return _ended(None)
    verdict = await evaluate_session(request, state, auth, user, token)
    if verdict.reason is not None:
        if verdict.reason == "revoked" and str(
            (verdict.row or {}).get("revoke_reason") or ""
        ) in _DELIBERATE_SIGNOUTS:
            # A deliberate sign-out of this very session needs no explanation.
            return _ended(None)
        lifetime: int | None = None
        row_remembered: bool | None = None
        if verdict.row is not None and verdict.limits is not None:
            idle, absolute = verdict.limits.for_row(verdict.row)
            if verdict.reason == "absolute_expired":
                lifetime = absolute or None
            elif verdict.reason == "idle_expired":
                lifetime = idle or None
            row_remembered = bool(verdict.row.get("remember"))
        return _ended(verdict.reason, lifetime, row_remembered)
    session: dict[str, Any] = {"remember": bool(getattr(user, "remember", False))}
    if verdict.row is not None and verdict.limits is not None:
        from ..stores.sessions import SessionStore

        expires_at, idle_expires_at = SessionStore.effective_expiry(
            verdict.row, **verdict.limits.kwargs()
        )
        # Remembered only while the LIVE policy still remembers this principal
        # (Remember me on, role not excluded).
        remembered = bool(verdict.row.get("remember")) and verdict.limits.remember_enabled
        session.update(
            remember=remembered,
            expires_at=expires_at,
            idle_expires_at=idle_expires_at,
        )
        if cookie_token and bool(verdict.row.get("remember")) and not remembered:
            # Remember me was turned off or this role was excluded after the sign-in:
            # turn the persistent cookie into a browser-session cookie, so it no
            # longer survives a browser restart (the server already judges the
            # session by the standard limits).
            _set_session_cookie(response, state, cookie_token)
    else:
        session["expires_at"] = _token_expires_iso(state, token or "")
    return {
        "authenticated": True,
        "auth_enabled": True,
        "user": {
            "username": user.username,
            "role": _resolved_role(state, user),
            "must_change_password": bool(user.must_change_password),
            "mfa_enabled": bool(getattr(user, "mfa_enabled", False)),
        },
        "session": session,
        "object_scoped": _object_scoped_for(state, user),
    }


@router.post("/auth/logout")
async def auth_logout(
    request: Request, response: Response, state: AppState = Depends(get_state)
) -> dict[str, Any]:
    # Wave 3: revoke THIS session's sid in the registry (so the token can't be
    # replayed even before its JWT exp). Best-effort; auth-off is a strict no-op.
    auth = getattr(state, "auth", None)
    if auth is not None and auth.is_enabled:
        token = request.cookies.get("tlsoc_token") or _bearer(request)
        claims = auth.claims_of(token) if token else None
        sid = str((claims or {}).get("sid") or "")
        username = str((claims or {}).get("sub") or "")
        if sid:
            revoked = False
            try:
                revoked = bool(await state.sessions.revoke(sid, by=username, reason="logout"))
            except Exception:  # noqa: BLE001
                pass
            if revoked:
                await _record_identity_event(
                    state, request, action="auth.logout", actor=username, surface="session",
                    user=auth.principal(username) if username else None, sid=sid,
                    summary=_session_summary("session_revoke", sid, "logout"),
                    target=_user_target(username),
                )
            # A chat answer this session started stops with it (never raises).
            await _stop_chat_turns(state, username, sid=sid)
    # Mirror the set_cookie attributes so the cookie is reliably cleared.
    _clear_session_cookie(response, state)
    return {"ok": True}


class ChangePasswordBody(BaseModel):
    current_password: str
    new_password: str


@router.post("/auth/change-password")
async def auth_change_password(
    body: ChangePasswordBody, request: Request, state: AppState = Depends(get_state)
) -> dict[str, Any]:
    """Self-service password change (requires a valid session). Verifies the current
    password, sets the new one and clears ``must_change_password``. Works only for
    multi-user accounts; the env single-admin has no persisted record to update."""
    auth = state.auth
    if not auth.is_enabled:
        raise HTTPException(status_code=400, detail="authentication is disabled")
    token = request.cookies.get("tlsoc_token") or _bearer(request)
    principal = auth.verify(token) if token else None
    if principal is None:
        raise HTTPException(status_code=401, detail="authentication required")
    new_pw = (body.new_password or "").strip()
    if len(new_pw) < 8:
        raise HTTPException(status_code=400, detail="new password must be at least 8 characters")
    # Re-authenticate with the current password (constant-time, no oracle).
    if auth.authenticate(principal.username, body.current_password) is None:
        await _record_identity_event(
            state, request, action="auth.password_change_failed", outcome="failure",
            actor=principal.username, summary="password change refused: current password incorrect",
            target=_user_target(principal.username),
        )
        raise HTTPException(status_code=400, detail="current password is incorrect")
    user = await state.users.get(principal.username)
    if user is None:
        raise HTTPException(
            status_code=400,
            detail="this account is managed via environment configuration and cannot self-change",
        )
    from ..auth.passwords import hash_password

    async def _write() -> None:
        # An account deleted while the row was appended answers 404, so its failure
        # row is written instead of a password change that never happened.
        await _patch_user_or_404(
            state,
            principal.username,
            password_hash=hash_password(new_pw),
            must_change_password=False,
        )

    # Round 14 (SPEC §3.6): a credential change is never made without its audit row.
    # Only the store write is the audited unit; the synced view is refreshed after
    # it, so a refresh error can never pair a saved change with a "not applied" row.
    await audited_write(
        state, sink="control", action="auth.password_changed",
        target=_user_target(principal.username), expected_revision=None,
        changes=[{"field": "password", "before": None, "after": None, "secret": True}],
        write=_write, action_type=ActionType.AUTH_EVENT, actor=principal.username,
        surface="auth", context=audit_context(request), result_summary="password changed",
    )
    await state.refresh_users()
    return {"ok": True}


# --------------------------------------------------------------------------- #
# Sessions & access policy — Wave 3
#
# A short-lived signed JWT is the ACCESS token; a parallel SessionStore registry
# adds revocation + idle/absolute expiry + per-session metadata. Endpoints below let
# a user see + terminate their OWN sessions, rotate a refresh token (with reuse
# detection), step up (re-auth), and let an admin force-terminate any session. Every
# create/revoke is audited (#2); session metadata renders PLAIN (#9); no secret is
# ever returned (#10). All auth-off paths are strict no-ops / 400s.
# --------------------------------------------------------------------------- #
class RefreshBody(BaseModel):
    refresh_token: str = ""


class ReauthBody(BaseModel):
    password: str = ""


class RevokeOthersBody(BaseModel):
    notify: bool = False


def _require_auth_enabled(state: AppState) -> None:
    if not getattr(state.auth, "is_enabled", False):
        raise HTTPException(status_code=400, detail="authentication is disabled")


@router.get("/sessions")
async def list_my_sessions(request: Request, state: AppState = Depends(get_state)) -> dict[str, Any]:
    """The caller's OWN sessions (UI-safe projection; current session flagged)."""
    principal = _require_session(state, request)
    rows = await state.sessions.list_for(principal.username)
    current_sid = getattr(principal, "sid", None)
    limits = live_session_limits(state, principal)
    return {
        "sessions": [
            {
                **state.sessions.public(r, limits),
                "current": bool(current_sid and r.get("sid") == current_sid),
            }
            for r in rows
        ],
        "current_sid": current_sid or "",
    }


@router.post("/sessions/{sid}/revoke")
async def revoke_my_session(
    sid: str, request: Request, state: AppState = Depends(get_state)
) -> dict[str, Any]:
    """Revoke ONE of the caller's own sessions by sid. 404 if it isn't theirs."""
    principal = _require_session(state, request)
    row = await state.sessions.get(sid)
    if row is None or _norm_user(row.get("username", "")) != _norm_user(principal.username):
        raise HTTPException(status_code=404, detail="session not found")
    # Round 12: signing out THIS device is a deliberate sign-out (like logout), so the
    # sign-in page must not later say it was "ended from another device".
    self_signout = bool(getattr(principal, "sid", None)) and principal.sid == sid
    ok = await state.sessions.revoke(
        sid, by=principal.username, reason="self_signout" if self_signout else "user_revoke"
    )
    if ok:
        await _record_identity_event(
            state, request, action="session.revoked", actor=principal.username,
            surface="session", target=_user_target(principal.username),
            summary=_session_summary("session_revoke", sid, "self revoke"),
            tool_input=_session_tool_input(state, sid, current=self_signout),
        )
    await _stop_chat_turns(state, principal.username, sid=sid)
    return {"ok": True, "revoked": bool(ok)}


@router.post("/sessions/revoke-others")
async def revoke_other_sessions(
    body: RevokeOthersBody, request: Request, state: AppState = Depends(get_state)
) -> dict[str, Any]:
    """Sign out all of the caller's OTHER sessions (keep this one). Bumps the user's
    token_version so any still-valid JWT is rejected next request, EXCEPT the kept
    sid (its row is preserved). Audited (#2)."""
    principal = _require_session(state, request)
    keep = getattr(principal, "sid", "") or ""
    count = await state.sessions.revoke_others(
        principal.username, keep, by=principal.username,
    )
    if keep:
        await _stop_chat_turns(state, principal.username, except_sid=keep)
    await _record_identity_event(
        state, request, action="session.revoked", actor=principal.username,
        surface="session", target=_user_target(principal.username),
        summary=_session_summary("session_revoke_others", keep, f"revoked {count} other session(s)"),
        tool_input={"scope": "others", "count": int(count or 0)},
    )
    if body.notify:
        try:
            await _notify_session_event(state, principal.username, "terminate", {})
        except Exception:  # noqa: BLE001
            pass
    return {"ok": True, "revoked": count}


@router.post("/auth/refresh")
async def auth_refresh(
    body: RefreshBody, request: Request, response: Response,
    state: AppState = Depends(get_state),
) -> dict[str, Any]:
    """Rotate a refresh token → mint a fresh ACCESS token + a NEW refresh token.

    Reuse detection (theft): if the presented token matches an ALREADY-ROTATED
    previous hash, the session is treated as compromised → revoke + bump the user's
    token_version (global sign-out) + audit + best-effort notify, and 401."""
    _require_auth_enabled(state)
    from ..stores.sessions import hash_refresh, new_refresh_token

    presented = (body.refresh_token or "").strip()
    if not presented:
        raise HTTPException(status_code=400, detail="refresh_token is required")
    row, match = await state.sessions.find_by_refresh(presented)
    if match == "prev":
        # THEFT: a replay of a rotated token. Nuke every session for the user.
        username = str((row or {}).get("username") or "")
        await state.sessions.revoke_all(username, by="system", reason="refresh_reuse_detected")
        await state.refresh_sessions()
        await _stop_chat_turns(state, username)
        reused_sid = str((row or {}).get("sid") or "")
        # The system revoked them (the store records ``by="system"``), not the
        # account holder: the account is the target, the reused session is named in
        # ``tool_input`` like every other revocation of a session that is not the
        # actor's own, and the request's credential is never read.
        await _record_identity_event(
            state, request, action="session.revoked", actor="system", surface="session",
            actor_type="system", outcome="success",
            target=_user_target(username),
            summary=_session_summary(
                "refresh_reuse", reused_sid, "refresh-token reuse detected; all sessions revoked",
            ),
            tool_input=_session_tool_input(
                state, reused_sid, scope="all", reason="refresh_reuse_detected",
            ),
            from_request=False,
        )
        try:
            await _notify_session_event(state, username, "terminate", {})
        except Exception:  # noqa: BLE001
            pass
        raise HTTPException(status_code=401, detail={"code": "session_invalid", "reason": "refresh_reuse"})
    if row is None or match != "current":
        raise HTTPException(status_code=401, detail={"code": "session_invalid", "reason": "unknown_refresh"})
    sid = str(row.get("sid") or "")
    username = str(row.get("username") or "")
    # The session must still be usable (not revoked/expired) to rotate — judged by
    # the limits that apply to THIS row (standard or remembered, Round 12) for the
    # account's LIVE role (an excluded role is never remembered).
    limits = limits_for_username(state, username)
    reason = state.sessions.is_active(row, **limits.kwargs())
    if reason is not None:
        raise HTTPException(status_code=401, detail={"code": "session_expired", "reason": reason})
    # A remembered session stays remembered, but rotation can never extend it past
    # its absolute limit (created_at + the remembered duration).
    remember_seconds = 0
    if bool(row.get("remember")) and limits.remember_enabled:
        from ..utils import parse_es_timestamp

        created_dt = parse_es_timestamp(row.get("created_at"))
        remaining = (
            int(created_dt.timestamp() + limits.remember_absolute - now_utc().timestamp())
            if created_dt is not None else limits.remember_absolute
        )
        remember_seconds = max(60, min(remaining, limits.remember_absolute))
    minted = state.auth.mint_session(username, remember_seconds=remember_seconds)
    if minted is None:
        raise HTTPException(status_code=401, detail={"code": "session_invalid", "reason": "inactive_user"})
    token, _principal = minted
    # The NEW access token carries a NEW sid. Keep ONE logical session row by
    # RE-KEYING the existing row to the new sid + rotating its refresh hash (the old
    # refresh hash slides to refresh_prev_hash for theft detection). This preserves
    # the created_at anchor (absolute lifetime) while the access sid resolves.
    new_refresh = new_refresh_token()
    new_sid = str((state.auth.claims_of(token) or {}).get("sid") or "")
    idle_for_row, _absolute_for_row = limits.for_row(row)
    rotated = await state.sessions.rekey_and_rotate(
        sid, new_sid, hash_refresh(new_refresh),
        idle_timeout=idle_for_row,
        token_expires_at=_token_expires_iso(state, token),
    )
    if rotated is not None:
        _rebind_chat_turns(state, username, sid, new_sid, token)
    await _record_identity_event(
        state, request, action="session.refreshed", actor=username, surface="session",
        user=state.auth.principal(username), sid=new_sid,
        summary=_session_summary("refresh_rotate", new_sid, f"rotated from {_short(sid)}"),
        target=_user_target(username), from_request=False,
    )
    _set_session_cookie(response, state, token, remember_seconds=remember_seconds)
    return {"token": token, "refresh_token": new_refresh, "sid": new_sid}


@router.post("/auth/reauth")
async def auth_reauth(
    body: ReauthBody, request: Request, state: AppState = Depends(get_state)
) -> dict[str, Any]:
    """Step-up (sudo): re-verify the current user's password and stamp a fresh
    ``last_authn_at`` on the session so a ``require_fresh_auth``-gated action is
    unlocked for the policy window. Audited (#2)."""
    principal = _require_session(state, request)
    if state.auth.authenticate(principal.username, body.password or "") is None:
        await _record_identity_event(
            state, request, action="auth.reauth_failed", outcome="failure",
            actor=principal.username, surface="session", summary="reauth failed",
            target=_user_target(principal.username),
        )
        raise HTTPException(status_code=401, detail={"code": "reauth_required", "reason": "bad_password"})
    sid = getattr(principal, "sid", "") or ""
    if sid:
        await state.sessions.stamp_authn(sid)
    await _record_identity_event(
        state, request, action="auth.reauthenticated", actor=principal.username,
        surface="session", summary=_session_summary("session_reauth", sid, "step-up re-auth ok"),
        target=_user_target(principal.username),
    )
    return {"ok": True}


@router.get("/account/activity")
async def account_activity(
    request: Request, limit: int = Query(default=50, ge=1, le=200),
    state: AppState = Depends(get_state),
) -> dict[str, Any]:
    """The caller's OWN recent account/audit activity (newest first). Reads the
    append-only audit log filtered by actor. Read-only; never raises."""
    principal = _require_session(state, request)
    rows = await _records_for_actor(state, principal.username, limit)
    return {"activity": rows}


# --------------------------------------------------------------------------- #
# Admin sessions console — Wave 3 (require_admin = users:manage). Step-up gated.
# --------------------------------------------------------------------------- #
@router.get("/admin/sessions")
async def admin_list_sessions(
    request: Request, state: AppState = Depends(get_state),
    _admin=Depends(require_admin),
) -> dict[str, Any]:
    """Every session across all users (admin console). UI-safe projection."""
    rows = await state.sessions.list_all()
    # Each row is projected with ITS owner's live limits (an excluded role is never
    # shown as remembered); one lookup per user.
    by_user: dict[str, Any] = {}

    def _limits(row: dict[str, Any]):
        key = _norm_user(str(row.get("username") or ""))
        if key not in by_user:
            by_user[key] = limits_for_username(state, str(row.get("username") or ""))
        return by_user[key]

    return {"sessions": [state.sessions.public(r, _limits(r)) for r in rows]}


@router.post("/admin/sessions/{sid}/revoke")
async def admin_revoke_session(
    sid: str, request: Request, state: AppState = Depends(get_state),
    _admin=Depends(require_admin),
    _fresh=Depends(require_fresh_auth()),
) -> dict[str, Any]:
    """Admin force-terminate ANY session by sid. Step-up gated. Audited (#2)."""
    row = await state.sessions.get(sid)
    if row is None:
        raise HTTPException(status_code=404, detail="session not found")
    by = current_username(request)
    ok = await state.sessions.revoke(sid, by=by, reason="admin_revoke")
    if ok:
        await _record_identity_event(
            state, request, action="session.revoked", actor=by, surface="session",
            target=_user_target(str(row.get("username") or "")),
            summary=_session_summary(
                "session_admin_revoke", sid, f"admin revoked session of {row.get('username', '')}",
            ),
            tool_input=_session_tool_input(state, sid),
        )
    await _stop_chat_turns(state, str(row.get("username") or ""), sid=sid)
    return {"ok": True, "revoked": bool(ok)}


@router.post("/admin/users/{username}/revoke-all")
async def admin_revoke_all(
    username: str, request: Request, state: AppState = Depends(get_state),
    _admin=Depends(require_admin),
    _fresh=Depends(require_fresh_auth()),
) -> dict[str, Any]:
    """Admin global sign-out for ONE user: revoke every session + bump token_version.
    Step-up gated. Audited (#2)."""
    by = current_username(request)
    count = await state.sessions.revoke_all(username, by=by, reason="admin_revoke_all")
    await state.refresh_sessions()
    await _stop_chat_turns(state, username)
    await _record_identity_event(
        state, request, action="session.revoked", actor=by, surface="session",
        target=_user_target(username),
        summary=_session_summary(
            "session_admin_revoke_all", "", f"admin revoked all {count} session(s) for {username}",
        ),
        tool_input={"scope": "all", "count": int(count or 0)},
    )
    return {"ok": True, "revoked": count}


def _norm_user(username: str) -> str:
    return (username or "").strip().lower()


async def _stop_chat_turns(
    state: AppState, username: str, *, sid: str | None = None, except_sid: str | None = None,
) -> int:
    """Stop the running chat answers whose session or account just ended (Round 12
    final review, L1): ``routes_chat.stop_chat_turns_for``, imported lazily
    (``routes_chat`` imports this module). Never raises."""
    from .routes_chat import stop_chat_turns_for

    return await stop_chat_turns_for(state, username, sid=sid, except_sid=except_sid)


async def _recheck_chat_turns(state: AppState, username: str) -> int:
    """Re-check the user's running chat answers after an account change (disabled,
    role or custom roles changed) and stop those that lost their authority."""
    from .routes_chat import recheck_chat_turns_for

    return await recheck_chat_turns_for(state, username)


def _rebind_chat_turns(state: AppState, username: str, old_sid: str, new_sid: str,
                       token: str) -> int:
    """A refresh re-keyed the session: its running chat answers follow the new sid
    and the new access token's expiry (``routes_chat.rebind_chat_turns_for``)."""
    from .routes_chat import rebind_chat_turns_for

    try:
        exp = float((state.auth.claims_of(token) or {}).get("exp") or 0) or None
    except (TypeError, ValueError):
        exp = None
    return rebind_chat_turns_for(state, username, old_sid, new_sid, token_expires_at=exp)


def _short(sid: str) -> str:
    s = str(sid or "")
    return (s[:8] + "…") if len(s) > 8 else s


async def _records_for_actor(state: AppState, actor: str, limit: int) -> list[dict[str, Any]]:
    """Read the caller's own audit rows (newest first) via the audit repository's
    per-actor reader. Best-effort — returns [] on any error."""
    audit = getattr(state, "control_audit", None)
    if audit is None:
        return []
    try:
        return await audit.records_for_actor(actor, limit)
    except Exception:  # noqa: BLE001
        return []


# --------------------------------------------------------------------------- #
# Account self-service profile — Wave 2 / W2
#
# A user edits their OWN non-secret profile (display name / avatar / contact /
# locale / a small UI-prefs bag). Gated by an authenticated session (current_user)
# — NOT users:manage — so any logged-in user can edit themselves but only their own
# record. The env single-admin (no persisted User) is read-only here. Secrets never
# appear in a profile and public() never leaks the password/MFA material (#10). All
# fields are rendered as PLAIN text by the UI (#9).
# --------------------------------------------------------------------------- #
# Cap on the serialized self-service prefs bag (keeps the user KV doc small).
_MAX_PREFS_JSON_LEN = 8_000


class AccountProfileBody(BaseModel):
    """A self-service profile patch. EVERY field is optional — only provided
    (non-None) fields are written; an omitted field is left unchanged. Clearing a
    field is an explicit empty string / empty object (never null)."""

    display_name: str | None = None
    alias: str | None = None
    avatar: str | None = None
    alt_email: str | None = None
    timezone: str | None = None
    locale: str | None = None
    prefs: dict[str, Any] | None = None


class AvatarBody(BaseModel):
    """Thin set/clear of just the avatar (empty string clears it)."""

    avatar: str = ""


# Per-field caps for the free-text profile strings (rendered as plain text; bound
# the user KV doc). Matches the BrandingConfig text-length discipline.
_MAX_PROFILE_TEXT = 200


def _empty_profile() -> dict[str, Any]:
    return {
        "display_name": "", "alias": "", "avatar": "", "alt_email": "",
        "timezone": "", "locale": "", "prefs": {},
    }


def _account_principal(state: AppState, request: Request):
    """Resolve the authenticated principal for the account routes, or raise.

    Mirrors :func:`_require_session`: 400 when auth is disabled (no account to
    manage), 401 when no valid session is presented."""
    auth = state.auth
    if not auth.is_enabled:
        raise HTTPException(status_code=400, detail="authentication is disabled")
    principal = current_user(request)
    if principal is None:
        raise HTTPException(status_code=401, detail="authentication required")
    return principal


@router.get("/account/me")
async def account_me(request: Request, state: AppState = Depends(get_state)) -> dict[str, Any]:
    """The caller's own account view. Auth-disabled → an anonymous stub; the env
    single-admin (no persisted User) → identity + ``env_managed:true`` + an empty
    profile; a real multi-user account → its ``public()`` projection."""
    auth = state.auth
    if not auth.is_enabled:
        return {
            "authenticated": True, "auth_enabled": False, "env_managed": False,
            "user": {"username": "", "role": UserRole.SUPER_ADMIN.value, **_empty_profile()},
        }
    principal = current_user(request)
    if principal is None:
        raise HTTPException(status_code=401, detail="authentication required")
    user = await state.users.get(principal.username)
    if user is None:
        # Env single-admin: a real session but no persisted record to edit.
        return {
            "authenticated": True, "auth_enabled": True, "env_managed": True,
            "user": {
                "username": principal.username,
                "role": _resolved_role(state, principal),
                **_empty_profile(),
            },
        }
    return {
        "authenticated": True, "auth_enabled": True, "env_managed": False,
        "user": user.public(),
    }


def _validate_profile_text(value: str, field: str) -> str:
    if len(value) > _MAX_PROFILE_TEXT:
        raise HTTPException(
            status_code=400, detail=f"{field} too long (max {_MAX_PROFILE_TEXT} characters)"
        )
    return value


def _image_marker(value: Any) -> str | None:
    """An avatar as the audit log records it: whether one is set, never the image."""
    return "image" if value else None


def _account_changes(user: Any, patch: dict[str, Any]) -> list[Any]:
    """The audit ``changes`` of an account edit (SPEC §4.5.3): each patched profile
    field from its stored value to the new one; the avatar as set or cleared (never
    the image); the personal preference bag field by field (secrets withheld); a
    password or MFA secret only as "changed"."""
    out: list[Any] = []
    for field in sorted(patch):
        new = patch[field]
        old = getattr(user, field, None)
        if field == "avatar":
            before, after = _image_marker(old), _image_marker(new)
            if before != after or (old != new):
                out.append({"field": "avatar", "before": before, "after": after})
        elif field == "prefs":
            out.extend(diff_changes(old if isinstance(old, dict) else {},
                                    new if isinstance(new, dict) else {}, prefix="prefs"))
        elif field in ("password_hash", "mfa_secret", "mfa_recovery_hashes", "mfa_last_step"):
            if field == "password_hash":
                out.append({"field": "password", "before": None, "after": None, "secret": True})
            elif field == "mfa_secret":
                out.append({"field": "mfa_secret", "before": None, "after": None, "secret": True})
        else:
            old_v = getattr(old, "value", old)
            new_v = getattr(new, "value", new)
            if old_v != new_v:
                out.extend(diff_changes({field: old_v}, {field: new_v}))
    return out


@router.put("/account/me")
async def update_account_me(
    body: AccountProfileBody, request: Request, state: AppState = Depends(get_state)
) -> dict[str, Any]:
    """Patch the caller's OWN profile. Authenticated-session gated (not
    users:manage). The env single-admin (no persisted record) is rejected with 400,
    matching the change-password seam."""
    principal = _account_principal(state, request)
    user = await state.users.get(principal.username)
    if user is None:
        raise HTTPException(
            status_code=400,
            detail="this account is managed via environment configuration and cannot self-edit",
        )
    patch: dict[str, Any] = {}
    for field in ("display_name", "alias", "alt_email", "timezone", "locale"):
        val = getattr(body, field)
        if val is not None:
            patch[field] = _validate_profile_text(str(val), field)
    if body.avatar is not None:
        try:
            patch["avatar"] = validate_avatar(body.avatar)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
    if body.prefs is not None:
        import json

        try:
            serialized = json.dumps(body.prefs)
        except (TypeError, ValueError) as exc:
            raise HTTPException(status_code=400, detail="prefs is not JSON-serializable") from exc
        if len(serialized) > _MAX_PREFS_JSON_LEN:
            raise HTTPException(
                status_code=400, detail=f"prefs too large (max {_MAX_PREFS_JSON_LEN} bytes)"
            )
        # INVARIANT — ``prefs["custom_roles"]`` is a RESERVED key owned by the
        # admin surfaces (``PUT /api/users/{u}/roles`` in routes_roles.py and the
        # users:manage creation path): it is the assignment record that
        # ``deps._assigned_custom_roles`` UNIONs into every live RBAC decision.
        # A self-service profile update must NEVER add, remove, or reorder the
        # caller's admin-assigned custom roles — otherwise any authenticated user
        # could grant themselves an existing custom role's permissions by writing
        # this key, bypassing the users:manage + fresh-auth gate. Whatever the
        # client sent for the key is therefore discarded and the CURRENTLY STORED
        # value is carried forward verbatim (stored absent → stripped). The rest
        # of the bag stays a full replacement, so clients that round-trip the
        # prefs they read from ``public()`` keep working unchanged (no 4xx).
        sanitized_prefs = dict(body.prefs)
        stored_prefs = user.prefs or {}
        if "custom_roles" in stored_prefs:
            sanitized_prefs["custom_roles"] = stored_prefs["custom_roles"]
        else:
            sanitized_prefs.pop("custom_roles", None)
        patch["prefs"] = sanitized_prefs
    if not patch:
        raise HTTPException(status_code=400, detail="no changes provided")

    async def _write() -> Any:
        if "prefs" in patch:
            # The admin-assigned custom roles are carried forward from a read made
            # now, never from the read before the row was appended: an assignment
            # saved meanwhile is kept, not reverted by this profile save.
            fresh = await state.users.get(principal.username)
            if fresh is None:
                raise HTTPException(status_code=404, detail="user not found")
            fresh_prefs = fresh.prefs or {}
            prefs_patch = dict(patch["prefs"])
            if "custom_roles" in fresh_prefs:
                prefs_patch["custom_roles"] = fresh_prefs["custom_roles"]
            else:
                prefs_patch.pop("custom_roles", None)
            return await _patch_user_or_404(
                state, principal.username, **{**patch, "prefs": prefs_patch}
            )
        return await _patch_user_or_404(state, principal.username, **patch)

    updated = await audited_write(
        state, sink="control", action="user.updated",
        target=_user_target(principal.username, getattr(user, "display_name", "") or None),
        expected_revision=None, changes=_account_changes(user, patch), write=_write,
        action_type=ActionType.AUTH_EVENT, actor=principal.username, surface="account",
        context=audit_context(request),
        result_summary=f"updated profile ({', '.join(sorted(patch))})",
    )
    await state.refresh_users()
    return {"ok": True, "user": (updated or user).public()}


@router.put("/me/avatar")
async def update_my_avatar(
    body: AvatarBody, request: Request, state: AppState = Depends(get_state)
) -> dict[str, Any]:
    """Thin set/clear of just the caller's avatar (empty string clears it)."""
    principal = _account_principal(state, request)
    user = await state.users.get(principal.username)
    if user is None:
        raise HTTPException(
            status_code=400,
            detail="this account is managed via environment configuration and cannot self-edit",
        )
    try:
        avatar = validate_avatar(body.avatar or "")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    async def _write() -> Any:
        return await _patch_user_or_404(state, principal.username, avatar=avatar)

    updated = await audited_write(
        state, sink="control", action="user.updated",
        target=_user_target(principal.username, getattr(user, "display_name", "") or None),
        expected_revision=None, changes=_account_changes(user, {"avatar": avatar}),
        write=_write, action_type=ActionType.AUTH_EVENT, actor=principal.username,
        surface="account", context=audit_context(request),
        result_summary=("cleared avatar" if not avatar else "updated avatar"),
    )
    await state.refresh_users()
    return {"ok": True, "user": (updated or user).public()}


# --------------------------------------------------------------------------- #
# MFA (TOTP) — Wave 2 / F3
# --------------------------------------------------------------------------- #
def _mfa_issuer(state: AppState) -> str:
    """The authenticator issuer label: Preferences.mfa.issuer → branding.org_name →
    "Agentic SOC"."""
    mfa = getattr(state.prefs, "mfa", None)
    issuer = (getattr(mfa, "issuer", "") or "").strip()
    if issuer:
        return issuer
    org = (getattr(getattr(state.prefs, "branding", None), "org_name", "") or "").strip()
    return org or "Agentic SOC"


def _mfa_params(state: AppState) -> tuple[int, int]:
    mfa = getattr(state.prefs, "mfa", None)
    return int(getattr(mfa, "digits", 6) or 6), int(getattr(mfa, "period", 30) or 30)


def _require_session(state: AppState, request: Request):
    """Resolve the authenticated principal from a FULL session, or raise 401/400.
    Used by the self-service MFA routes (setup/confirm/disable)."""
    auth = state.auth
    if not auth.is_enabled:
        raise HTTPException(status_code=400, detail="authentication is disabled")
    token = request.cookies.get("tlsoc_token") or _bearer(request)
    principal = auth.verify(token) if token else None
    if principal is None:
        raise HTTPException(status_code=401, detail="authentication required")
    return principal


# Where a freshly-generated, NOT-yet-confirmed TOTP secret + recovery codes are
# parked between /mfa/setup and /mfa/confirm. In-memory ONLY (secret tier) keyed by
# lowercased username — never persisted until the user proves possession via confirm.
_MFA_PENDING_ENROLL: dict[str, dict[str, Any]] = {}


def _mfa_changes(*, enabled: bool) -> list[dict[str, Any]]:
    """The audit ``changes`` of turning a second factor on or off: the flag, and the
    secret and recovery codes only as "changed" (never their values)."""
    return [
        {"field": "mfa_enabled", "before": "false" if enabled else "true",
         "after": "true" if enabled else "false"},
        {"field": "mfa_secret", "before": None, "after": None, "secret": True},
        {"field": "mfa_recovery_codes", "before": None, "after": None, "secret": True},
    ]


@router.post("/auth/mfa/setup")
async def mfa_setup(request: Request, state: AppState = Depends(get_state)) -> dict[str, Any]:
    """Begin MFA enrollment (self, authenticated). Generates a PENDING TOTP secret +
    recovery codes and returns them ONCE (the secret + otpauth URI for the QR, and the
    plaintext recovery codes for the user to save). Does NOT enable MFA — the user must
    prove possession via /auth/mfa/confirm. Re-calling regenerates the pending secret."""
    from ..auth import mfa as mfa_mod

    principal = _require_session(state, request)
    digits, period = _mfa_params(state)
    secret = mfa_mod.generate_secret()
    recovery = mfa_mod.generate_recovery_codes(10)
    uri = mfa_mod.provisioning_uri(
        secret, principal.username, _mfa_issuer(state), digits=digits, period=period
    )
    _MFA_PENDING_ENROLL[principal.username.strip().lower()] = {
        "secret": secret,
        "recovery_hashes": [mfa_mod.hash_recovery_code(c) for c in recovery],
    }
    await _record_identity_event(
        state, request, action="auth.mfa_setup_started", actor=principal.username,
        summary="mfa enrollment started", target=_user_target(principal.username),
    )
    return {"secret": secret, "otpauth_uri": uri, "recovery_codes": recovery}


class MfaCodeBody(BaseModel):
    code: str


@router.post("/auth/mfa/confirm")
async def mfa_confirm(
    body: MfaCodeBody, request: Request, state: AppState = Depends(get_state)
) -> dict[str, Any]:
    """Confirm MFA enrollment (self): verify a TOTP code against the PENDING secret,
    then persist the obfuscated secret + hashed recovery codes and set
    ``mfa_enabled=True``. Idempotent only in that a wrong code 400s and leaves MFA off."""
    from ..auth import mfa as mfa_mod

    principal = _require_session(state, request)
    pending = _MFA_PENDING_ENROLL.get(principal.username.strip().lower())
    if not pending:
        raise HTTPException(status_code=400, detail="no pending MFA enrollment; call setup first")
    digits, period = _mfa_params(state)
    ok, step = mfa_mod.verify_totp(
        pending["secret"], body.code, window=1, period=period, digits=digits
    )
    if not ok:
        raise HTTPException(status_code=400, detail="invalid code")
    user = await state.users.get(principal.username)
    if user is None:
        raise HTTPException(
            status_code=400,
            detail="this account is managed via environment configuration and cannot enroll MFA",
        )
    obf = mfa_mod.obfuscate_secret(pending["secret"], state.secrets.mfa_server_key())

    async def _write() -> None:
        # Patch only the second-factor fields: a change an administrator saves to
        # this account while the row is appended (role, active, password) is kept.
        await _patch_user_or_404(
            state, principal.username, mfa_enabled=True, mfa_secret=obf,
            mfa_recovery_hashes=list(pending["recovery_hashes"]), mfa_last_step=int(step),
        )

    # Round 14 (SPEC §3.6): turning a second factor on is never done without its row.
    await audited_write(
        state, sink="control", action="auth.mfa_enrolled",
        target=_user_target(principal.username), expected_revision=None,
        changes=_mfa_changes(enabled=True), write=_write,
        action_type=ActionType.AUTH_EVENT, actor=principal.username, surface="auth",
        context=audit_context(request), result_summary="mfa enabled",
    )
    await state.refresh_users()
    _MFA_PENDING_ENROLL.pop(principal.username.strip().lower(), None)
    return {"ok": True}


class MfaVerifyBody(BaseModel):
    pending_token: str
    code: str


@router.post("/auth/mfa/verify")
async def mfa_verify(
    body: MfaVerifyBody, request: Request, response: Response,
    state: AppState = Depends(get_state),
) -> dict[str, Any]:
    """Login phase 2 (PUBLIC — gated by the pending_token). Verify the TOTP code (or a
    single-use recovery code) for the pending-token subject; on success mint the full
    session, set the cookie, and return ``{token, user}``."""
    from ..auth import mfa as mfa_mod

    auth = state.auth
    if not auth.is_enabled:
        raise HTTPException(status_code=400, detail="authentication is disabled")
    username = auth.pending_subject(body.pending_token)
    if username is None:
        raise HTTPException(status_code=401, detail="invalid or expired pending session")
    user = await state.users.get(username)
    if user is None or not user.mfa_enabled:
        raise HTTPException(status_code=400, detail="MFA is not enabled for this account")
    digits, period = _mfa_params(state)
    server_key = state.secrets.mfa_server_key()
    secret = mfa_mod.deobfuscate_secret(user.mfa_secret, server_key)
    method = ""
    # 1) TOTP (with replay rejection against the stored last step).
    if secret:
        ok, step = mfa_mod.verify_totp(
            secret, body.code, window=1, period=period, digits=digits,
            last_step=user.mfa_last_step,
        )
        if ok:
            method = "totp"
            await state.users.update(username, mfa_last_step=int(step))
    # 2) Recovery code (single-use): consume the matching hash on success.
    if not method:
        remaining = list(user.mfa_recovery_hashes)
        match_idx = next(
            (i for i, h in enumerate(remaining) if mfa_mod.verify_recovery_code(body.code, h)),
            -1,
        )
        if match_idx >= 0:
            method = "recovery"
            del remaining[match_idx]
            await state.users.update(username, mfa_recovery_hashes=remaining)
    if not method:
        await _record_identity_event(
            state, request, action="auth.mfa_failed", outcome="failure", actor=username,
            user=auth.principal(username), summary="mfa verify failed",
            target=_user_target(username), from_request=False,
        )
        raise HTTPException(status_code=401, detail="invalid code")
    await state.refresh_users()
    # Round 12: the Remember-me REQUEST comes only from the SIGNED pending token
    # (never a body field), and eligibility is decided against the live policy now.
    remember_seconds, remember_reason = _remember_decision(
        state, request, auth.principal(username),
        auth.pending_remember(body.pending_token),
    )
    minted = auth.mint_session(username, remember_seconds=remember_seconds)
    if minted is None:  # pragma: no cover — username verified above
        raise HTTPException(status_code=401, detail="invalid credentials")
    token, principal = minted
    try:
        await state.users.update(username, last_login_at=iso_now())
    except Exception:  # noqa: BLE001
        pass
    await _record_identity_event(
        state, request, action="auth.login", actor=username, user=principal, token=token,
        summary=(
            f"mfa login ok ({method}; remembered {_duration_label(remember_seconds)})"
            if remember_seconds > 0 else f"mfa login ok ({method})"
        ),
        target=_user_target(username),
        tool_input={"method": method, "remembered": remember_seconds > 0},
        from_request=False,
    )
    # Wave 3: register the session from the freshly-minted token (carries sid/tv).
    await _register_session(
        state, request, token, mfa_method=method, remember_seconds=remember_seconds
    )
    _set_session_cookie(response, state, token, remember_seconds=remember_seconds)
    return {
        "token": token,
        "user": {
            "username": principal.username,
            "role": _resolved_role(state, principal),
            "must_change_password": bool(principal.must_change_password),
            "mfa_enabled": True,
        },
        **_remember_fields(state, token, remember_seconds, remember_reason),
    }


# --------------------------------------------------------------------------- #
# Mandated MFA enrollment DURING login (additive). When login returns
# ``mfa_enrollment_required`` (required-but-not-enrolled), the client completes
# enrollment here, gated by the SAME short-lived pending token (mfa:"pending") the
# code-challenge path uses — NOT a full session (there is none yet). Both routes:
#   * accept ONLY the pending-token kind (``pending_subject``; ``verify()`` keeps
#     rejecting pending tokens everywhere else, so a pending token still cannot
#     reach any protected route);
#   * 400 for an env-managed account (no persisted User → cannot enroll; the
#     requires_mfa lockout guard means it is never sent here anyway);
#   * 400 for an ALREADY-ENROLLED account — a password-only attacker holding a
#     pending token must never be able to REPLACE the existing factor (they must
#     clear /auth/mfa/verify with the real one);
#   * are audited at every step (#2).
# --------------------------------------------------------------------------- #
class MfaEnrollSetupBody(BaseModel):
    pending_token: str


class MfaEnrollConfirmBody(BaseModel):
    pending_token: str
    code: str


async def _enroll_pending_user(state: AppState, pending_token: str):
    """Resolve + guard the pending-token principal for the login-phase enrollment
    routes. Returns ``(username, User)`` or raises 400/401 (see block comment)."""
    auth = state.auth
    if not auth.is_enabled:
        raise HTTPException(status_code=400, detail="authentication is disabled")
    username = auth.pending_subject(pending_token)
    if username is None:
        raise HTTPException(status_code=401, detail="invalid or expired pending session")
    user = await state.users.get(username)
    if user is None:
        raise HTTPException(
            status_code=400,
            detail="this account is managed via environment configuration and cannot enroll MFA",
        )
    if user.mfa_enabled:
        raise HTTPException(
            status_code=400,
            detail="MFA is already enrolled for this account; verify with your existing factor",
        )
    if not auth.requires_mfa(username):
        raise HTTPException(
            status_code=400, detail="MFA enrollment is not required for this account"
        )
    return username, user


@router.post("/auth/mfa/enroll-setup")
async def mfa_enroll_setup(
    body: MfaEnrollSetupBody, request: Request, state: AppState = Depends(get_state)
) -> dict[str, Any]:
    """Begin MANDATED MFA enrollment during login (PUBLIC — gated by the pending
    token). Same response shape as the session-authed /auth/mfa/setup: a PENDING
    TOTP secret + otpauth URI + one-time recovery codes. Nothing is persisted until
    the user proves possession via /auth/mfa/enroll-confirm."""
    from ..auth import mfa as mfa_mod

    username, _user = await _enroll_pending_user(state, body.pending_token)
    digits, period = _mfa_params(state)
    secret = mfa_mod.generate_secret()
    recovery = mfa_mod.generate_recovery_codes(10)
    uri = mfa_mod.provisioning_uri(
        secret, username, _mfa_issuer(state), digits=digits, period=period
    )
    _MFA_PENDING_ENROLL[username.strip().lower()] = {
        "secret": secret,
        "recovery_hashes": [mfa_mod.hash_recovery_code(c) for c in recovery],
    }
    await _record_identity_event(
        state, request, action="auth.mfa_setup_started", actor=username,
        user=state.auth.principal(username), summary="mfa enrollment started (login-mandated)",
        target=_user_target(username), tool_input={"mandated": True}, from_request=False,
    )
    return {"secret": secret, "otpauth_uri": uri, "recovery_codes": recovery}


@router.post("/auth/mfa/enroll-confirm")
async def mfa_enroll_confirm(
    body: MfaEnrollConfirmBody, request: Request, response: Response,
    state: AppState = Depends(get_state),
) -> dict[str, Any]:
    """Complete MANDATED MFA enrollment during login (PUBLIC — gated by the pending
    token): verify the TOTP code against the PENDING secret, persist the enrollment
    (exactly like /auth/mfa/confirm), then mint the FULL session + cookie exactly
    like the /auth/mfa/verify success tail — the user lands fully signed in."""
    from ..auth import mfa as mfa_mod

    auth = state.auth
    username, user = await _enroll_pending_user(state, body.pending_token)
    pending = _MFA_PENDING_ENROLL.get(username.strip().lower())
    if not pending:
        raise HTTPException(
            status_code=400, detail="no pending MFA enrollment; call enroll-setup first"
        )
    digits, period = _mfa_params(state)
    ok, step = mfa_mod.verify_totp(
        pending["secret"], body.code, window=1, period=period, digits=digits
    )
    if not ok:
        await _record_identity_event(
            state, request, action="auth.mfa_failed", outcome="failure", actor=username,
            user=auth.principal(username), summary="mfa enrollment confirm failed",
            target=_user_target(username), from_request=False,
        )
        raise HTTPException(status_code=401, detail="invalid code")
    # Persist the enrollment (the same block as /auth/mfa/confirm), audit-first.
    obf = mfa_mod.obfuscate_secret(pending["secret"], state.secrets.mfa_server_key())

    async def _write() -> None:
        await _patch_user_or_404(
            state, username, mfa_enabled=True, mfa_secret=obf,
            mfa_recovery_hashes=list(pending["recovery_hashes"]), mfa_last_step=int(step),
        )

    await audited_write(
        state, sink="control", action="auth.mfa_enrolled",
        target=_user_target(username), expected_revision=None,
        changes=_mfa_changes(enabled=True), write=_write,
        action_type=ActionType.AUTH_EVENT, actor=username, surface="auth",
        context=audit_context(request, user=auth.principal(username), from_request=False),
        result_summary="mfa enabled (login-mandated enrollment)",
        tool_input={"mandated": True},
    )
    await state.refresh_users()
    _MFA_PENDING_ENROLL.pop(username.strip().lower(), None)
    # Mint the FULL session — the /auth/mfa/verify success tail (incl. the signed
    # Remember-me request carried by the pending token, Round 12).
    remember_seconds, remember_reason = _remember_decision(
        state, request, auth.principal(username),
        auth.pending_remember(body.pending_token),
    )
    minted = auth.mint_session(username, remember_seconds=remember_seconds)
    if minted is None:  # pragma: no cover — username verified above
        raise HTTPException(status_code=401, detail="invalid credentials")
    token, principal = minted
    try:
        await state.users.update(username, last_login_at=iso_now())
    except Exception:  # noqa: BLE001
        pass
    await _record_identity_event(
        state, request, action="auth.login", actor=username, user=principal, token=token,
        summary=(
            "mfa login ok (totp; enrolled at login; remembered "
            f"{_duration_label(remember_seconds)})"
            if remember_seconds > 0 else "mfa login ok (totp; enrolled at login)"
        ),
        target=_user_target(username),
        tool_input={"method": "totp", "remembered": remember_seconds > 0, "enrolled_at_login": True},
        from_request=False,
    )
    await _register_session(
        state, request, token, mfa_method="totp", remember_seconds=remember_seconds
    )
    _set_session_cookie(response, state, token, remember_seconds=remember_seconds)
    return {
        "token": token,
        "user": {
            "username": principal.username,
            "role": _resolved_role(state, principal),
            "must_change_password": bool(principal.must_change_password),
            "mfa_enabled": True,
        },
        **_remember_fields(state, token, remember_seconds, remember_reason),
    }


@router.post("/auth/mfa/disable")
async def mfa_disable(
    body: MfaCodeBody, request: Request, state: AppState = Depends(get_state)
) -> dict[str, Any]:
    """Disable MFA for the calling user (self). Requires a valid CURRENT TOTP or a
    single-use recovery code (so a hijacked session alone cannot turn MFA off).
    Clears the secret + recovery hashes. (A super_admin can force-disable another
    user via PUT /api/users/{username} {mfa_enabled:false}.)"""
    from ..auth import mfa as mfa_mod

    principal = _require_session(state, request)
    user = await state.users.get(principal.username)
    if user is None or not user.mfa_enabled:
        raise HTTPException(status_code=400, detail="MFA is not enabled for this account")
    digits, period = _mfa_params(state)
    secret = mfa_mod.deobfuscate_secret(user.mfa_secret, state.secrets.mfa_server_key())
    ok = False
    if secret:
        ok, _ = mfa_mod.verify_totp(
            secret, body.code, window=1, period=period, digits=digits,
            last_step=user.mfa_last_step,
        )
    if not ok:
        ok = any(mfa_mod.verify_recovery_code(body.code, h) for h in user.mfa_recovery_hashes)
    if not ok:
        await _record_identity_event(
            state, request, action="auth.mfa_failed", outcome="failure",
            actor=principal.username, summary="mfa disable refused: invalid code",
            target=_user_target(principal.username),
        )
        raise HTTPException(status_code=400, detail="invalid code")

    async def _write() -> None:
        # ``update`` drops only ``None``, so the empty secret, list and step are written.
        await _patch_user_or_404(
            state, principal.username,
            mfa_enabled=False, mfa_secret="", mfa_recovery_hashes=[], mfa_last_step=0,
        )

    # Round 14 (SPEC §3.6): turning a second factor off is never done without its row.
    await audited_write(
        state, sink="control", action="auth.mfa_disabled",
        target=_user_target(principal.username), expected_revision=None,
        changes=_mfa_changes(enabled=False), write=_write,
        action_type=ActionType.AUTH_EVENT, actor=principal.username, surface="auth",
        context=audit_context(request), result_summary="mfa disabled",
    )
    await state.refresh_users()
    return {"ok": True}


# --------------------------------------------------------------------------- #
# SSO (OIDC) — Wave 2 / F4
#
# The single-use ``state``-token round-trip lives in ``app.auth.oidc.OidcStateStore``
# (the namespace + TTL are owned there), reached through the PUBLIC
# ``AppState.oidc_state`` accessor — the routes never touch ``state._kv`` directly
# (Round 5 / Coupling-F / G8, P13).
# --------------------------------------------------------------------------- #
def _sso_redirect_uri(request: Request) -> str:
    """The absolute callback URL to hand the IdP — derived from THIS request's base
    URL so it matches whatever host the browser reached us on (proxy-aware)."""
    base = str(request.base_url).rstrip("/")
    return f"{base}/api/auth/sso/callback"


def _build_oidc_provider(state: AppState, provider_id: str):
    """Construct an :class:`OidcProvider` for ``provider_id`` from prefs + the
    secret-tier client secret, or raise 404 when unknown/disabled."""
    from ..auth.oidc import OidcProvider

    sso = getattr(state.prefs, "sso", None)
    if sso is None or not sso.enabled:
        raise HTTPException(status_code=404, detail="SSO is not enabled")
    cfg = sso.get(provider_id)
    if cfg is None or not cfg.enabled:
        raise HTTPException(status_code=404, detail="unknown SSO provider")
    return OidcProvider(
        cfg.model_dump(mode="json"),
        client_secret=state.secrets.sso_client_secret(provider_id),
    )


# Short-lived HttpOnly cookie binding the OIDC ``state`` to the initiating browser (#38).
_OIDC_STATE_COOKIE = "tlsoc_oidc_state"


@router.get("/auth/sso/providers")
async def sso_providers(state: AppState = Depends(get_state)) -> dict[str, Any]:
    """PUBLIC: the ENABLED SSO providers (id/type/display_name only — no secrets)."""
    sso = getattr(state.prefs, "sso", None)
    out = []
    for p in (sso.enabled_providers() if sso else []):
        out.append({"id": p.id, "type": p.type, "display_name": p.display_name or p.id})
    return {"providers": out}


@router.get("/auth/sso/authorize")
async def sso_authorize(
    request: Request,
    response: Response,
    provider: str = Query(...),
    remember: bool = False,  # query parameter (a plain default keeps direct calls safe)
    state: AppState = Depends(get_state),
) -> dict[str, Any]:
    """PUBLIC: build the IdP authorization URL. Stashes a single-use state+nonce in
    the KV (ns ``oidc_state``) with a short TTL via the public ``state.oidc_state``
    store (P13), then returns ``{auth_url}`` for the browser to follow.

    The ``state`` token is ALSO bound to the initiating browser via a short-lived
    HttpOnly SameSite cookie (audit #38): the callback requires the cookie to match the
    returned ``state``, so a stolen/forged authorization response cannot be replayed in a
    victim's browser (login CSRF / session fixation)."""
    from ..auth import oidc as oidc_mod

    prov = _build_oidc_provider(state, provider)
    state_tok = oidc_mod.new_state()
    nonce = oidc_mod.new_nonce()
    redirect_uri = _sso_redirect_uri(request)
    try:
        auth_url = await prov.authorization_url(
            state=state_tok, nonce=nonce, redirect_uri=redirect_uri
        )
    except oidc_mod.OidcError as exc:
        raise HTTPException(status_code=502, detail=f"SSO unavailable: {exc}") from exc
    await state.oidc_state.stash(state_tok, {
        "provider": provider,
        "nonce": nonce,
        "redirect_uri": redirect_uri,
        "expires_at": iso_now(),
        # Round 12: the Remember-me REQUEST, bound server-side to this single-use
        # state; eligibility is decided at the callback against the live policy.
        "remember": bool(remember),
    })
    response.set_cookie(
        _OIDC_STATE_COOKIE, state_tok, max_age=600, httponly=True, samesite="lax",
        secure=state.secrets.auth_cookie_secure, path="/",
    )
    return {"auth_url": auth_url}


@router.get("/auth/sso/callback")
async def sso_callback(
    request: Request,
    response: Response,
    state: AppState = Depends(get_state),
    code: str = Query(default=""),
    state_param: str = Query(default="", alias="state"),
) -> Response:
    """PUBLIC: the IdP redirect target. Validates state, exchanges the code
    server-side, calls userinfo, enforces the domain/tenant allowlist + group→role
    map, provisions the user when ``auto_create_users`` is on, mints the session
    cookie, and 302-redirects to ``/``. On any error → ``/login?sso_error=...``."""
    from fastapi.responses import RedirectResponse

    from ..auth import oidc as oidc_mod

    def _fail(reason: str) -> Response:
        return RedirectResponse(url=f"/login?sso_error={quote_plus(reason)}", status_code=302)

    if not code or not state_param:
        return _fail("missing_code_or_state")
    # Browser binding (audit #38): the state returned by the IdP MUST match the
    # HttpOnly cookie this browser was given at /authorize, so a forged/replayed
    # authorization response can't complete in a victim's session (login CSRF).
    import hmac as _hmac

    cookie_state = request.cookies.get(_OIDC_STATE_COOKIE) or ""
    if not cookie_state or not _hmac.compare_digest(cookie_state, state_param):
        resp = _fail("state_not_bound")
        resp.delete_cookie(_OIDC_STATE_COOKIE, path="/")
        return resp
    rec = await state.oidc_state.consume(state_param)
    if rec is None:
        return _fail("invalid_state")
    provider_id = str(rec.get("provider") or "")
    try:
        prov = _build_oidc_provider(state, provider_id)
    except HTTPException:
        return _fail("unknown_provider")
    try:
        tokens = await prov.exchange_code(
            code=code, redirect_uri=str(rec.get("redirect_uri") or _sso_redirect_uri(request))
        )
        claims = await prov.fetch_userinfo(str(tokens.get("access_token")))
    except oidc_mod.OidcError as exc:
        logger.warning("SSO exchange failed for %s: %s", provider_id, exc)
        return _fail("token_exchange_failed")
    identity = prov.identity_from(claims)
    if not identity.get("sub") or not identity.get("email"):
        return _fail("incomplete_identity")
    denied = prov.check_allowed(identity)
    if denied:
        await _record_identity_event(
            state, request, action="auth.login_failed", outcome="denied",
            actor=identity.get("email") or "", summary=f"sso denied: {denied}",
            tool_input={"method": f"sso:{provider_id}"}, from_request=False,
        )
        return _fail("not_allowed")
    role = prov.role_for(identity)
    try:
        username, refusal = await _provision_sso_user(state, request, provider_id, identity, role)
    except AuditUnavailableError:
        # Creating or changing the account is audit-first: nothing was changed.
        return _fail("audit_unavailable")
    if username is None:
        # One attempt, one row: a refused link is ``denied`` (the account-takeover
        # guard), anything else is a ``failure`` to provision.
        await _record_identity_event(
            state, request, action="auth.login_failed",
            outcome="denied" if refusal else "failure",
            actor=identity.get("email") or "",
            summary=refusal or "sso login rejected: user not provisioned",
            tool_input={"method": f"sso:{provider_id}"}, from_request=False,
        )
        return _fail("user_not_provisioned")
    await state.refresh_users()
    remember_seconds, remember_reason = _remember_decision(
        state, request, state.auth.principal(username), rec.get("remember") is True
    )
    minted = state.auth.mint_session(username, remember_seconds=remember_seconds)
    if minted is None:
        return _fail("session_failed")
    token, _principal = minted
    try:
        await state.users.update(username, last_login_at=iso_now())
    except Exception:  # noqa: BLE001
        pass
    await _record_identity_event(
        state, request, action="auth.login", actor=username, user=_principal, token=token,
        summary=(
            f"sso login ok ({provider_id}; remembered {_duration_label(remember_seconds)})"
            if remember_seconds > 0 else f"sso login ok ({provider_id})"
        ),
        target=_user_target(username),
        tool_input={"method": f"sso:{provider_id}", "remembered": remember_seconds > 0},
        from_request=False,
    )
    # Wave 3: register the SSO session from the freshly-minted token (carries sid/tv).
    await _register_session(
        state, request, token, mfa_method=f"sso:{provider_id}",
        remember_seconds=remember_seconds,
    )
    # A refused remember request is reported on the landing URL (a closed reason
    # vocabulary, never free text) so the console can explain it once.
    landing = "/"
    if rec.get("remember") is True and remember_seconds <= 0:
        landing = f"/?remember_refused={quote_plus(remember_reason)}"
    redirect = RedirectResponse(url=landing, status_code=302)
    _set_session_cookie(redirect, state, token, remember_seconds=remember_seconds)
    redirect.delete_cookie(_OIDC_STATE_COOKIE, path="/")  # one-time binding consumed (#38)
    return redirect


async def _provision_sso_user(
    state: AppState, request: Request, provider_id: str, identity: dict[str, Any], role: str
) -> tuple[str | None, str | None]:
    """Map an SSO identity to a local account; provision it (atomically) when
    ``auto_create_users`` is on. Returns ``(username, None)``, or ``(None, refusal)``
    when no account may be used: ``refusal`` is the reason when the link was refused
    (the caller writes the one ``auth.login_failed`` row for the attempt) and ``None``
    when no matching user exists and auto-provisioning is off.

    Matching precedence: an EXISTING user already linked to this (provider, sub) →
    (only when the IdP asserts a VERIFIED email) an existing SSO-managed user by that
    email → else (if allowed) create one. The account key is the verified email when
    available, else the non-spoofable ``provider:sub``. Idempotent: a returning user is
    NOT duplicated; its role is refreshed from the group map.

    Round 14 (SPEC §3.6, §4.5.4): creating the account, and changing its role or its
    link on a later sign-in, is audit-first (``user.created``, ``user.role_changed``,
    ``user.updated``; the actor is the system acting for the identity provider). A
    failed append raises :class:`AuditUnavailableError` and nothing is changed.

    SECURITY (#3, SSO account takeover): we NEVER link an SSO login to a pre-existing
    LOCAL-credential account by email, and we NEVER trust an UNVERIFIED email as an
    account key. Either would let an attacker whose IdP account carries a victim's
    address log in AS the victim."""
    from ..auth.passwords import hash_password

    sso = getattr(state.prefs, "sso", None)
    cfg = sso.get(provider_id) if sso else None
    auto_create = bool(getattr(cfg, "auto_create_users", False))
    email = str(identity.get("email") or "").strip()
    email_verified = bool(identity.get("email_verified"))
    sub = str(identity.get("sub") or "").strip()
    if not sub:
        return None, None  # no stable subject → cannot key an account safely
    # Only trust the email as an account key when the IdP asserts it is verified;
    # otherwise key on the immutable provider+sub (an attacker cannot forge that).
    trusted_email = email if (email and email_verified) else ""
    username = trusted_email or f"{provider_id}:{sub}"
    method = f"sso:{provider_id}"
    context = audit_context(request, from_request=False)

    # 1) An account already LINKED to this (provider, sub) — always safe to reuse.
    existing = None
    for u in await state.users.list():
        if u.oauth_provider == provider_id and u.oauth_sub and u.oauth_sub == sub:
            existing = u
            break

    # 2) Otherwise match by the VERIFIED email — but refuse to auto-link onto a
    #    pre-existing LOCAL-credential account (real password, not already linked to
    #    THIS provider). That refusal is the account-takeover guard.
    if existing is None and trusted_email:
        candidate = await state.users.get(trusted_email)
        if candidate is not None:
            already_linked_here = candidate.oauth_provider == provider_id
            is_local_account = bool(candidate.password_hash) and not candidate.oauth_provider
            if is_local_account and not already_linked_here:
                return None, f"sso link refused: {provider_id} email matches a local account"
            existing = candidate

    if existing is not None:
        # Idempotent re-login: refresh role + provider linkage, never duplicate.
        if not existing.active:
            return None, None
        old_role = str(getattr(existing.role, "value", existing.role) or "")
        new_role = role if (cfg and cfg.group_role_map) else old_role
        update = {
            "role": new_role,
            "oauth_provider": provider_id,
            "oauth_sub": sub or existing.oauth_sub,
        }
        patch = {
            key: value for key, value in update.items()
            if str(getattr(getattr(existing, key, None), "value", getattr(existing, key, None)) or "")
            != str(value or "")
        }
        if not patch:
            return existing.username, None  # nothing to change, nothing to record
        role_changed = "role" in patch

        async def _save_existing() -> None:
            # Only the fields this sign-in changes: an administrator's change to the
            # account saved while the row is appended (active, password) is kept.
            if await state.users.update(existing.username, **patch) is None:
                raise _SsoAccountGone(f"user '{existing.username}' no longer exists")

        try:
            await audited_write(
                state, sink="control",
                action="user.role_changed" if role_changed else "user.updated",
                target=_user_target(
                    existing.username, getattr(existing, "display_name", "") or None
                ),
                expected_revision=None, changes=_account_changes(existing, patch),
                write=_save_existing, action_type=ActionType.USER_MGMT, actor=method,
                actor_type="system", surface="auth", context=context,
                tool_input={"method": method},
                result_summary=(
                    f"single sign-on changed the role of '{existing.username}' from {old_role} "
                    f"to {new_role} ({provider_id} group map)"
                    if role_changed
                    else f"single sign-on linked '{existing.username}' to {provider_id}"
                ),
            )
        except _SsoAccountGone:
            # Deleted while the row was appended: its failure row is written and the
            # sign-in fails as "not provisioned".
            return None, None
        return existing.username, None

    if not auto_create:
        return None, None

    async def _create() -> str:
        # Atomic create-if-absent at our single-process scale: create() raises on a
        # concurrent duplicate, which becomes the failure row of this attempt (the
        # racing callback's own row records the creation) and is then reused.
        try:
            created = await state.users.create(
                username=username,
                password_hash=hash_password(secrets_token()),
                role=role,
                active=True,
                must_change_password=False,
            )
        except ValueError as exc:
            raise _SsoAccountExists(str(exc)) from exc
        if await state.users.update(
            created.username, oauth_provider=provider_id, oauth_sub=sub,
        ) is None:
            raise _SsoAccountGone(f"user '{created.username}' no longer exists")
        return created.username

    if await state.users.get(username) is not None:
        # Provisioned by a racing callback since the lookups above: reuse it.
        return username, None
    try:
        created_name = await audited_write(
            state, sink="control", action="user.created",
            target=_user_target(username), expected_revision=None,
            changes=diff_changes({}, {
                "role": role, "active": True, "oauth_provider": provider_id, "oauth_sub": sub,
            }),
            write=_create, action_type=ActionType.USER_MGMT, actor=method, actor_type="system",
            surface="auth", context=context, tool_input={"method": method},
            result_summary=f"single sign-on created user '{username}' ({role}) for {provider_id}",
        )
    except _SsoAccountExists:
        again = await state.users.get(username)
        return (again.username if again else None), None
    except _SsoAccountGone:
        return None, None
    return created_name, None


class _SsoAccountGone(Exception):
    """The account a single sign-on write targets was deleted before the write ran."""


class _SsoAccountExists(Exception):
    """``users.create`` found the account already provisioned by a racing callback."""


def secrets_token() -> str:
    """A random, unusable password for an SSO-provisioned account (they log in via
    the IdP, never with a local password)."""
    import secrets as _s

    return _s.token_urlsafe(32)


class SSOProviderSecretBody(BaseModel):
    client_secret: str | None = None


@router.post("/auth/sso/providers/{provider_id}/secret")
async def set_sso_provider_secret(
    provider_id: str,
    body: SSOProviderSecretBody,
    request: Request,
    state: AppState = Depends(get_state),
    _admin=Depends(require_admin),
) -> dict[str, Any]:
    """Set/clear one OIDC provider's client secret (super_admin only). The value goes
    to the SECRET tier (in memory), NEVER to Preferences/the config doc; only a
    configured-boolean is returned."""
    async def _write() -> None:
        state.secrets.set_sso_client_secret(provider_id, body.client_secret)

    # Round 14 (SPEC §3.6): audited before it applies; the value is never recorded.
    await audited_write(
        state, sink="control", action="settings.updated",
        target={"type": "setting", "id": "sso", "label": "Single sign-on"},
        expected_revision=None,
        changes=[{"field": f"sso.{provider_id}.client_secret", "before": None, "after": None,
                  "secret": True}],
        write=_write, action_type=ActionType.AUTH_EVENT, actor=current_username(request),
        surface="auth", context=audit_context(request),
        result_summary=(
            f"sso client secret {'set' if body.client_secret else 'cleared'} for '{provider_id}'"
        ),
    )
    return {"ok": True, "configured": bool(state.secrets.sso_client_secret(provider_id))}


# --------------------------------------------------------------------------- #
# RBAC: roles matrix (for the UI) + multi-user administration
# --------------------------------------------------------------------------- #
@router.get("/roles")
async def list_roles(state: AppState = Depends(get_state)) -> dict[str, Any]:
    """The role -> resource -> [actions] matrix (default merged with any operator
    override + the admin-managed custom roles) for the webui's permission checks + the
    RBAC settings view. Folds the out-of-band :class:`CustomRoleStore` roles into the
    surfaced matrix so a stored custom role appears alongside the built-ins."""
    from ..rbac.policy import resolve_matrix

    from .deps import _rbac_config_with_custom_roles

    rbac = await _rbac_config_with_custom_roles(state)
    base = getattr(state.prefs, "rbac", None)
    # ADDITIVE (Round-6 #20): surface the RAW custom-role definitions (name /
    # description / inherits / grants / denies) alongside the RESOLVED matrix so the
    # Roles editor can restore the exact draft on Edit/Clone (the resolved matrix
    # flattens inheritance into explicit grants and drops description). Normalised to
    # plain JSON dicts (#9 — rendered escaped, never fed to a prompt); never a secret.
    raw_custom_roles: list[dict[str, Any]] = []
    for cr in (getattr(rbac, "custom_roles", []) or []):
        if hasattr(cr, "model_dump"):
            raw_custom_roles.append(cr.model_dump(mode="json"))
        elif isinstance(cr, dict):
            raw_custom_roles.append(dict(cr))
    return {
        "roles": [r.value for r in UserRole],
        "default_role": getattr(base, "default_role", UserRole.ANALYST_TIER1.value),
        "rbac_enabled": bool(getattr(base, "enabled", False)),
        "matrix": resolve_matrix(rbac),
        "custom_roles": raw_custom_roles,
    }


class UserCreateBody(BaseModel):
    username: str
    password: str
    role: str = UserRole.ANALYST_TIER1.value
    # Admin-set profile/contact fields (optional, additive — plain text, #9).
    # ``display_name`` doubles as the full name (the existing field — no duplicate).
    display_name: str = ""
    email: str = ""
    phone: str = ""
    # The MFA-enrollment MANDATE (required ≠ enrolled — never mints a secret; the
    # ``mfa_enabled`` admin-enable guard below does NOT apply to this flag).
    mfa_required: bool = False
    # Existing CUSTOM roles to assign at creation (by name; validated exactly like
    # PUT /api/users/{u}/roles and persisted into prefs["custom_roles"] the same
    # way). The BASE ``role`` must remain one of the six built-ins.
    custom_roles: list[str] | None = None


class UserUpdateBody(BaseModel):
    role: str | None = None
    active: bool | None = None
    password: str | None = None
    # Wave 2 / F3 — a super_admin may FORCE-DISABLE another user's MFA (e.g. lost
    # device). Only False is honored here; enabling MFA is always a self-service
    # enroll (setup→confirm) so the user actually possesses the authenticator.
    mfa_enabled: bool | None = None
    # Admin-set profile/contact fields + the MFA mandate (None = leave unchanged;
    # clearing a text field is an explicit empty string).
    display_name: str | None = None
    email: str | None = None
    phone: str | None = None
    mfa_required: bool | None = None


_VALID_ROLES = {r.value for r in UserRole}


def _validate_role(role: str) -> str:
    if role not in _VALID_ROLES:
        raise HTTPException(status_code=400, detail=f"unknown role: {role}")
    return role


def _validate_email_text(value: str) -> str:
    """Lenient contact-email sanity: capped plain text that contains an ``@`` and no
    whitespace. Contact metadata, not an auth identifier — kept deliberately loose."""
    v = (value or "").strip()
    if not v:
        return ""
    _validate_profile_text(v, "email")
    if "@" not in v or any(ch.isspace() for ch in v):
        raise HTTPException(
            status_code=400, detail="email must contain '@' and no whitespace"
        )
    return v


_PHONE_CHARSET = frozenset("+0123456789 -()")


def _validate_phone_text(value: str) -> str:
    """Lenient phone sanity: capped plain text over the charset ``+ 0-9 space - ( )``."""
    v = (value or "").strip()
    if not v:
        return ""
    _validate_profile_text(v, "phone")
    if not all(ch in _PHONE_CHARSET for ch in v):
        raise HTTPException(
            status_code=400,
            detail="phone may only contain digits, spaces, and + - ( )",
        )
    return v


async def _validate_custom_role_names(
    state: AppState, names: list[str]
) -> list[str]:
    """Validate a custom-role assignment list EXACTLY like the assign path in
    routes_roles.py (``PUT /api/users/{u}/roles``): reject a built-in name (400) and
    a name absent from the resolved matrix (400); de-duplicate, preserve order."""
    from ..rbac.policy import resolve_matrix

    from .deps import _rbac_config_with_custom_roles

    matrix = resolve_matrix(await _rbac_config_with_custom_roles(state))
    cleaned: list[str] = []
    for nm in names:
        nm_s = str(nm).strip()
        if not nm_s:
            continue
        if nm_s in _VALID_ROLES:
            raise HTTPException(
                status_code=400,
                detail=f"'{nm_s}' is a built-in role, not a custom role",
            )
        if nm_s not in matrix:
            raise HTTPException(status_code=400, detail=f"unknown custom role: {nm_s}")
        if nm_s not in cleaned:
            cleaned.append(nm_s)
    return cleaned


@router.get("/users")
async def list_users(
    state: AppState = Depends(get_state),
    _=Depends(require_permission("users", "manage")),
) -> dict[str, Any]:
    users = await state.users.list()
    return {"users": [u.public() for u in users]}


@router.post("/users")
async def create_user(
    body: UserCreateBody,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("users", "manage")),
) -> dict[str, Any]:
    pw = (body.password or "").strip()
    if len(pw) < 8:
        raise HTTPException(status_code=400, detail="password must be at least 8 characters")
    _validate_role(body.role)
    display_name = _validate_profile_text((body.display_name or "").strip(), "display_name")
    email = _validate_email_text(body.email)
    phone = _validate_phone_text(body.phone)
    # Custom roles at creation: validated exactly like the assign path and carried
    # in prefs["custom_roles"] (the same shape PUT /users/{u}/roles writes). No
    # lockout guard is needed here — creation can only ADD grants, never remove.
    custom_roles: list[str] = []
    if body.custom_roles is not None:
        custom_roles = await _validate_custom_role_names(state, body.custom_roles)
    from ..auth.passwords import hash_password

    # Pre-checks (no row): a missing or taken name is refused before anything is
    # attempted, with the answers the store gave before Round 14.
    if not (body.username or "").strip():
        raise HTTPException(status_code=409, detail="username is required")
    if await state.users.get(body.username) is not None:
        raise HTTPException(status_code=409, detail=f"user '{body.username}' already exists")
    extras = []
    if bool(body.mfa_required):
        extras.append("mfa_required")
    if custom_roles:
        extras.append(f"custom={custom_roles}")
    # What the new account holds, as the row records it (empty fields left out).
    created_fields = {
        key: value for key, value in {
            "role": body.role, "active": True, "must_change_password": True,
            "display_name": display_name, "email": email, "phone": phone,
            "mfa_required": bool(body.mfa_required), "custom_roles": custom_roles,
        }.items() if value not in ("", [], None)
    }

    async def _write() -> Any:
        try:
            created = await state.users.create(
                username=body.username,
                password_hash=hash_password(pw),
                role=body.role,
                active=True,
                must_change_password=True,
                display_name=display_name,
                email=email,
                phone=phone,
                mfa_required=bool(body.mfa_required),
                prefs=({"custom_roles": custom_roles} if custom_roles else None),
            )
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        return created

    # Round 14 (SPEC §3.6): the account exists only once its audit row does.
    user = await audited_write(
        state, sink="control", action="user.created",
        target=_user_target(body.username, display_name or None), expected_revision=None,
        changes=[
            *diff_changes({}, created_fields),
            {"field": "password", "before": None, "after": None, "secret": True},
        ],
        write=_write, action_type=ActionType.USER_MGMT, actor=current_username(request),
        surface="users", context=audit_context(request),
        result_summary=(
            f"created user '{body.username}' ({body.role})"
            + (f" [{' '.join(extras)}]" if extras else "")
        ),
    )
    await state.refresh_users()
    return {"ok": True, "user": user.public()}


async def _would_orphan_super_admin(state: AppState, target: "object", *, demoting: bool, disabling: bool) -> bool:
    """True if the requested change would remove the LAST active super_admin."""
    role = getattr(target, "role", "")
    if role != UserRole.SUPER_ADMIN.value or not getattr(target, "active", False):
        return False
    if not (demoting or disabling):
        return False
    remaining = await state.users.count_active_super_admins(super_admin_role=UserRole.SUPER_ADMIN.value)
    return remaining <= 1


@router.put("/users/{username}")
async def update_user(
    username: str,
    body: UserUpdateBody,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("users", "manage")),
) -> dict[str, Any]:
    target = await state.users.get(username)
    if target is None:
        raise HTTPException(status_code=404, detail="user not found")
    patch: dict[str, Any] = {}
    if body.role is not None:
        _validate_role(body.role)
        patch["role"] = body.role
    if body.active is not None:
        patch["active"] = body.active
    if body.password is not None:
        pw = body.password.strip()
        if len(pw) < 8:
            raise HTTPException(status_code=400, detail="password must be at least 8 characters")
        from ..auth.passwords import hash_password

        patch["password_hash"] = hash_password(pw)
        patch["must_change_password"] = True
    if body.mfa_enabled is False:
        # Force-disable: clear the secret material too (the user re-enrolls later).
        patch.update({
            "mfa_enabled": False, "mfa_secret": "", "mfa_recovery_hashes": [], "mfa_last_step": 0,
        })
    elif body.mfa_enabled is True:
        raise HTTPException(
            status_code=400,
            detail="MFA can only be enabled by the user via self-service enrollment",
        )
    # The MFA-enrollment MANDATE is admin-settable BOTH ways (required ≠ enrolled —
    # it never mints a secret, so the enable-guard above does not apply to it).
    if body.mfa_required is not None:
        patch["mfa_required"] = bool(body.mfa_required)
    if body.display_name is not None:
        patch["display_name"] = _validate_profile_text(
            str(body.display_name).strip(), "display_name"
        )
    if body.email is not None:
        patch["email"] = _validate_email_text(body.email)
    if body.phone is not None:
        patch["phone"] = _validate_phone_text(body.phone)
    if not patch:
        raise HTTPException(status_code=400, detail="no changes provided")
    demoting = body.role is not None and body.role != UserRole.SUPER_ADMIN.value
    disabling = body.active is False
    if await _would_orphan_super_admin(state, target, demoting=demoting, disabling=disabling):
        raise HTTPException(
            status_code=409, detail="cannot demote or disable the last active super_admin"
        )

    async def _write() -> Any:
        return await _patch_user_or_404(state, username, **patch)

    old_role = getattr(target.role, "value", target.role)
    role_changed = "role" in patch and str(patch["role"]) != str(old_role)
    # Round 14 (SPEC §3.6): audited before the change is visible.
    updated = await audited_write(
        state, sink="control",
        action="user.role_changed" if role_changed else "user.updated",
        target=_user_target(username, getattr(target, "display_name", "") or None),
        expected_revision=None, changes=_account_changes(target, patch), write=_write,
        action_type=ActionType.USER_MGMT, actor=current_username(request), surface="users",
        context=audit_context(request),
        result_summary=(
            f"updated user '{username}': role changed from {old_role} to {patch['role']}"
            if role_changed else f"updated user '{username}'"
        ),
    )
    await state.refresh_users()
    if "role" in patch or "active" in patch:
        # A disabled account's running chat answers stop now; a role change stops
        # only those that relied on a grant the account no longer holds.
        await _recheck_chat_turns(state, username)
    return {"ok": True, "user": (updated or target).public()}


@router.delete("/users/{username}")
async def delete_user(
    username: str,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("users", "manage")),
) -> dict[str, Any]:
    target = await state.users.get(username)
    if target is None:
        raise HTTPException(status_code=404, detail="user not found")
    if await _would_orphan_super_admin(state, target, demoting=True, disabling=True):
        raise HTTPException(status_code=409, detail="cannot delete the last active super_admin")
    from ..engine.jobs import account_generation

    async def _write() -> None:
        # The deletion itself: the account's jobs and artifacts are retired and the
        # account removed. Only these persisting steps are the audited unit. An
        # account deleted (or deleted and made again) while the row was appended
        # answers 404, so its failure row is written instead of a deletion this
        # request never made.
        current = await state.users.get(username)
        if current is None or current.created_at != target.created_at:
            raise HTTPException(status_code=404, detail="user not found")
        generation = account_generation(target.username, target.created_at)
        artifacts, _removed_jobs = await state.jobs.retire_actor(username, generation)
        await state.job_runner.delete_artifacts(artifacts)
        if not await state.users.delete(username):
            raise HTTPException(status_code=404, detail="user not found")

    old_role = getattr(target.role, "value", target.role)
    # Round 14 (SPEC §3.6): the account and its data are removed only once the
    # deletion is on the audit log.
    await audited_write(
        state, sink="control", action="user.deleted",
        target=_user_target(username, getattr(target, "display_name", "") or None),
        expected_revision=None,
        changes=[{"field": "role", "before": str(old_role or ""), "after": None}],
        write=_write, action_type=ActionType.USER_MGMT, actor=current_username(request),
        surface="users", context=audit_context(request),
        result_summary=f"deleted user '{username}'",
    )
    # After the deletion is saved and recorded: the account is gone from the synced
    # view first (its token now fails every request, so no new chat turn can start),
    # then its running chat answers stop and unwind before its chat material is
    # purged, so none of them writes it back. An error here keeps its pre-Round-14
    # behaviour and never pairs the saved deletion with a "not applied" row.
    await state.refresh_users()
    await _stop_chat_turns(state, username)
    from ..stores.chat_feedback import feedback_store_for
    from ..stores.chat_starters import starters_store_for

    real_chat = state.real_chat_conversations
    real_chat_kv = getattr(real_chat, "_kv", None) or state.kv
    await state.auth.purge_user_side_state(
        username,
        inbox=state.real_inbox,
        notif_prefs=state.notif_prefs,
        user_prefs=state.user_prefs,
        custom_roles=state.custom_roles,
        chat_conversations=real_chat,
        chat_feedback=feedback_store_for(real_chat_kv),
        reports=state.real_reports,
        # Round 13 (SPEC-chat §3.2.3): the user's chat starter state goes with the
        # ratings, over the same REAL chat KV.
        chat_starters=starters_store_for(real_chat_kv),
    )
    return {"ok": True}


# --------------------------------------------------------------------------- #
# Cases
# --------------------------------------------------------------------------- #
class CaseListResponse(BaseModel):
    """The paged case-list envelope. ``cases`` is the full ``Case`` model list (the
    same shape ``Case.model_dump(mode='json')`` produced before typing)."""

    cases: list[Case]
    total: int
    # ADDITIVE: whether ``total`` is the PROVEN count of rows matching the requested
    # ``from``/``to`` window across the whole corpus. ``True`` on the bundled
    # Elasticsearch/SQL stores, which push the window down as a real backend clause.
    # ``False`` means ``total`` answers a DIFFERENT question than the one asked and must
    # not be presented as the window's count — either a third-party case repository fell
    # back to the bounded-scan compatibility path (``total`` is a lower bound), or a
    # supplied ``from``/``to`` bound could not be parsed and was dropped, so the applied
    # window is wider than the requested one (an unreadable bound is never silently
    # resolved to ``now()``, which would empty the window instead). ``null`` when NO
    # window was requested — the windowless response is otherwise unchanged, so a client
    # can distinguish "not applicable" from "not proven".
    window_total_exact: bool | None = None


class CaseListEcho(BaseModel):
    """The ADDITIVE keys a case-list response gains when the request engaged one of the
    paging/sort parameters (``sort_field`` / ``sort_order`` / ``status_group``).

    They are echoes of what the server actually applied. Every one exists because the
    matching server decision was previously INVISIBLE, and an invisible clamp is
    indistinguishable from a small result set.

    They are appended to the response ONLY for a request that asked for them, so a
    client that sends none of the new parameters keeps receiving the exact
    :class:`CaseListResponse` envelope it has always received — key for key. Answering a
    question nobody asked is not additive to a caller that has to parse the answer.
    """

    # Which fields this deployment can actually sort a case listing by. The console
    # builds its sort menu from THIS, so a deployment whose store supports a different
    # set gets the right menu with no client change and no client-side literal list.
    sortable_fields: list[str]
    # What the server sorted by, after the allow-list. A request that asked for an
    # unsupported field is answered in the DEFAULT order, and this says so rather than
    # letting the client believe its sort was honoured.
    sort_field: str
    sort_order: str
    # What the server actually paged with, after clamping.
    limit_applied: int
    offset_applied: int
    # The largest ``offset`` this endpoint will accept for ``limit_applied``, so a
    # client can stop before it asks for a page the store cannot serve.
    max_offset: int
    # The multi-status lifecycle group that was applied, if any.
    status_group_applied: str | None = None


# The case-list SORT ALLOW-LIST, enforced at this HTTP boundary and nowhere lower.
#
# It has to live ABOVE both bundled stores because the two disagree about an unknown
# field and NEITHER disagreement is safe to expose:
#
#   * the Elasticsearch store interpolates the field name straight into the query
#     document as a KEY (``{"sort": [{field: {...}}]}``). A mapped ``text`` field, an
#     ``enabled: false`` object, or an unmapped name is a 400 from the cluster, which
#     would surface as a 500 from this route; and no escaping can make an attacker-chosen
#     document key safe after the fact, so the name must be CHOSEN, not sanitised.
#   * the SQL repository silently falls back to ``created_at``, which means it answers a
#     different question than it was asked and never says so.
#
# The in-memory Elasticsearch double accepts ANY key and resolves an unplaceable value to
# a sentinel, so an allow-list asserted only against it would pass offline and 400 in
# production. Membership below is therefore chosen against the REAL contracts: every
# entry is a universal ``Case`` field that is sortably mapped in ``es/indices``
# ``CASES_MAPPING`` AND has a real ORDER BY expression in the SQL repository's
# ``_case_sort_column`` (``risk_score`` via its numeric JSON extraction). ``severity_band``
# is deliberately absent: it is derived at READ time after paging and is not stored,
# mapped or materialised anywhere, so no store can order by it.
CASE_SORT_FIELDS: tuple[str, ...] = ("created_at", "updated_at", "risk_score")
CASE_SORT_ORDERS: tuple[str, ...] = ("desc", "asc")
CASE_SORT_FIELD_DEFAULT = CASE_SORT_FIELDS[0]
CASE_SORT_ORDER_DEFAULT = CASE_SORT_ORDERS[0]

# The largest page this endpoint serves. Naming the existing literal changes nothing
# about the clamp; it makes the clamp quotable in the response (``limit_applied``).
CASE_PAGE_LIMIT = 200

# Elasticsearch/OpenSearch reject a ``from + size`` deeper than ``index.max_result_window``
# (default 10 000) rather than truncating, so offset paging has a hard ceiling on the
# bundled default backend. Basis: the same default this repository already pins for the
# LOG read path (``connectors/elastic._MAX_RESULT_WINDOW``); the case path had no ceiling
# at all, so a deep page surfaced as an unhandled backend error on real Elasticsearch and
# as plausible-looking wrong rows on the in-memory double. Refusing here is legible and
# identical on every backend.
CASE_RESULT_WINDOW = 10_000


def _with_advisory_bands(case: Case, prefs: Preferences | None) -> Case:
    """Populate the five READ-TIME advisory band fields (severity/impact/urgency/
    priority) on a Case copy for the presentation surfaces (Round-7 W0.7).

    ADDITIVE + FAIL-OPEN: derives the bands via the pure ``engine.priority.advisory_bands``
    and returns a ``model_copy`` update (never mutating the stored case). On ANY error the
    ORIGINAL case is returned unchanged so ``GET /api/cases`` + ``/{id}`` can never 500 on a
    malformed case. NONE of these bands feeds ``case_manager.decide()`` (#3)."""
    try:
        return case.model_copy(update=advisory_bands(case, prefs))
    except Exception:  # noqa: BLE001 — advisory only; never break the endpoint
        return case


def _case_view(case: Case, state: AppState) -> dict[str, Any]:
    """The JSON every single-case MUTATION returns (Round 12 final review): the same
    shape as ``GET /cases/{id}``, the stored case plus its read-time advisory bands
    under ``execution_prefs``. A client that renders the response (the Case Manager
    header after Acknowledge or Close) otherwise saw ``severity_band: null`` and fell
    back to a risk-score band, so a source-asserted Critical case read as Info until a
    reload. Display only: nothing here is stored or read by ``decide()`` (#3).

    Fail-open like the read path: the mutation is already saved when this runs, so a
    preference lookup that fails degrades to the prefs-free severity axis
    (``advisory_bands(case, None)``) instead of reporting a saved action as an error."""
    try:
        prefs: Preferences | None = state.execution_prefs
    except Exception:  # noqa: BLE001 — advisory only; never fail a saved mutation
        prefs = None
    return _with_advisory_bands(case, prefs).model_dump(mode="json")


# --------------------------------------------------------------------------- #
# Round 12 (WP-CM): the Case Manager queue's server-side search / owner / severity
# filters and its Title A–Z order.
#
# The queue used to load the newest 200 cases and filter Active, search and status in
# the BROWSER, so an open case older than the newest 200 was silently absent from the
# Active queue and no search could find it. The lifecycle group, sort and paging were
# already server-side; these four were not, because none of them is a push-down every
# store can answer exactly: free-text search spans ten fields (two nested), the owner
# match is case-insensitive, severity is a READ-TIME band (``engine.priority``, never
# stored or mapped), and ``title`` is a text field no store can order by.
#
# They are therefore answered by ONE exact scan over the store's own ``scan_page``
# (the same streaming read the exact aggregates use), with the lifecycle statuses
# pushed down as its pre-filter and every predicate re-checked here. The total is the
# true matching count over the whole corpus — never a page-bounded lower bound — and
# a request that sends none of these parameters never reaches this path.
# --------------------------------------------------------------------------- #
CASE_QUEUE_SEARCH_MAX_CHARS = 200
CASE_QUEUE_SEVERITIES: tuple[str, ...] = ("critical", "high", "medium", "low", "info")
# The AI verdict values (``constants.Verdict``) the queue's exact ``verdict`` filter
# accepts — a STRUCTURED match on the stored field, never the free-text search, so a
# title/summary/entity value that merely contains "needs_human" can never be counted.
CASE_QUEUE_VERDICTS: tuple[str, ...] = ("FALSE_POSITIVE", "TRUE_POSITIVE", "NEEDS_HUMAN")
CASE_QUEUE_SCAN_SORTS: tuple[str, ...] = ("title",)
CASE_QUEUE_SCAN_PAGE = 1000
# Round 12 final review (L1): the scan reads a PROJECTION, never whole case documents
# (which carry evidence and can be tens of kB each). These are the stored fields its
# predicates and sort keys read: the ten search fields, the filter inputs, every sort
# key, the severity-band inputs (``engine.priority.severity_band_from_events``) and the
# fields a ``Case`` requires, so a projected row validates exactly like the full one
# for every field a predicate reads. A transfer hint (``scan_page`` ``fields``): a
# store that ignores it returns whole documents, which is equally correct.
CASE_QUEUE_SCAN_FIELDS: tuple[str, ...] = (
    "case_id", "case_number", "title", "summary", "status", "verdict", "entity",
    "entity_type", "source_name", "assignee", "source_surface", "cluster_signature",
    "created_at", "updated_at", "risk_score", "severity_band", "trigger_reason",
    "source_id",
    # Round 14 (SPEC §4.6.1): the rule filter and search read ``rule_ids``; the
    # ``closed_by`` filter reads the decider and the analyst-policy payload.
    "rule_ids", "decision_by", "analyst_policy",
)
# Round 14 (SPEC §4.6.1, D27): who closed a terminal case, the engine's own values
# (``case_aggregate`` ``closed_by``): ``agent`` (an automatic close), ``analyst`` (a
# person), ``analyst_policy`` (an operator's declared-benign policy) and ``system``
# (deterministic routing and older rows with no recorded decider).
# These four are the only accepted values (SPEC §11.1 contract resolution 8): any other
# value, ``human`` included, is refused with a 400 rather than guessed at.
CASE_QUEUE_CLOSED_BY: tuple[str, ...] = ("agent", "analyst", "analyst_policy", "system")
# A scan page with at least this many rows has its predicate work (decoding, the
# validation a window or severity filter needs) run in a worker thread, so a broad
# search never stalls the event loop that also serves chat streams, SSE and ingest
# (the dashboards' ``_OFFLOAD_AT`` idea, applied per page).
CASE_QUEUE_OFFLOAD_AT = 200
# How many cases of the requested page are fetched at once when the store has no
# batch read (``get_many``).
CASE_QUEUE_FETCH_CONCURRENCY = 16


def _queue_value(row: Any, key: str) -> Any:
    """Read ``key`` off a raw stored document or a :class:`Case` (enum → value)."""
    value = row.get(key) if isinstance(row, dict) else getattr(row, key, None)
    return getattr(value, "value", value)


def _queue_entity(row: Any) -> tuple[str, str]:
    entity = _queue_value(row, "entity")
    if isinstance(entity, dict):
        etype, evalue = entity.get("type"), entity.get("value")
    else:
        etype, evalue = getattr(entity, "type", None), getattr(entity, "value", None)
    return str(etype or _queue_value(row, "entity_type") or ""), str(evalue or "")


def _queue_search_terms(q: str | None) -> list[str]:
    """Whitespace-separated, case-folded search terms (every term must match)."""
    text = str(q or "").strip()[:CASE_QUEUE_SEARCH_MAX_CHARS]
    return [t for t in text.casefold().split() if t]


def _queue_search_haystack(row: Any) -> str:
    """The ten fields the queue search has always matched, plus (Round 14, SPEC §4.6.1)
    the case's rule values, case-folded."""
    etype, evalue = _queue_entity(row)
    parts = [
        _queue_value(row, "case_id"), _queue_value(row, "case_number"),
        _queue_value(row, "title"), _queue_value(row, "summary"),
        _queue_value(row, "status"), _queue_value(row, "verdict"),
        etype, evalue, _queue_value(row, "source_name"), _queue_value(row, "assignee"),
    ]
    rules = _queue_value(row, "rule_ids")
    if isinstance(rules, (list, tuple)):
        parts.extend(rules)
    return " ".join(str(p) for p in parts if p not in (None, "")).casefold()


def _queue_rule_closed_by_check(
    rule: str | None, closed_by: str | None, prefs: Preferences,
) -> Callable[[Any], bool] | None:
    """The Round 14 ``rule`` and ``closed_by`` queue filters as one predicate over a raw
    row or a :class:`Case`, compiled by the exact-aggregation engine
    (``case_aggregate``: ``rule_exact`` is a value of ``Case.rule_ids`` exactly as
    stored, ``closed_by`` its terminal-close owner), so the Cases list, the rule summary
    and every case breakdown count the same cases. ``None`` when neither is asked for."""
    filters: dict[str, Any] = {}
    if rule is not None:
        filters["rule_exact"] = [rule]
    if closed_by is not None:
        filters["closed_by"] = [closed_by]
    if not filters:
        return None
    from ..engine.case_aggregate import _CaseView, _compile_case_filters

    predicate = _compile_case_filters(filters, prefs)
    return lambda row: bool(predicate(_CaseView(row, prefs)))


def _queue_title(row: Any) -> str:
    """The queue's display title chain (title → summary → number → id), case-folded."""
    for key in ("title", "summary", "case_number", "case_id"):
        value = _queue_value(row, key)
        if value not in (None, ""):
            return str(value).casefold()
    return ""


def _queue_score_band(score: float) -> str:
    """The console's ONE severity ladder for a 0..100 number (``badges.severityBand``)."""
    scaled = max(0.0, min(100.0, float(score)))
    if scaled >= 74:
        return "critical"
    if scaled >= 48:
        return "high"
    if scaled >= 22:
        return "medium"
    return "info" if scaled < 8 else "low"


def _queue_severity(case: Case) -> str:
    """The band the queue row DISPLAYS: the read-time severity band, else the risk
    band, else ``info`` — the same chain as the console's ``caseSeverity``."""
    return _queue_band(getattr(case, "severity_band", ""), getattr(case, "risk_score", None))


def _queue_band(band: Any, risk: Any) -> str:
    raw = str(band or "").strip().lower()
    aliases = {"crit": "critical", "med": "medium", "moderate": "medium",
               "informational": "info", "none": "info"}
    raw = aliases.get(raw, raw)
    if raw in CASE_QUEUE_SEVERITIES:
        return raw
    if isinstance(risk, (int, float)) and not isinstance(risk, bool):
        return _queue_score_band(risk)
    return "info"


def _queue_row_severity(case: Case, prefs: Preferences) -> str:
    """The band the list response shows for ``case`` — exactly what
    ``_queue_severity(_with_advisory_bands(case, prefs))`` returns (the advisory
    severity axis replaces the stored band; a failed derivation leaves none, and the
    risk band applies) — without deriving the impact, urgency and priority axes the
    filter never reads."""
    from ..engine.priority import severity_band_from_events

    try:
        band = severity_band_from_events(case, prefs).get("band")
    except Exception:  # noqa: BLE001 — advisory only, as in ``advisory_bands``
        band = None
    return _queue_band(band, getattr(case, "risk_score", None))


def _queue_sort_key(row: Any, field: str) -> tuple[Any, str]:
    tiebreak = str(_queue_value(row, "case_id") or "")
    if field == "title":
        return (_queue_title(row), tiebreak)
    if field == "risk_score":
        risk = _queue_value(row, "risk_score")
        number = float(risk) if isinstance(risk, (int, float)) and not isinstance(risk, bool) else -1.0
        return (number, tiebreak)
    millis = parse_millis_strict(_queue_value(row, field))
    return (millis if millis is not None else -1, tiebreak)


class _QueueDesc:
    """A sort key in REVERSED order (``heapq`` keeps the smallest item on top)."""

    __slots__ = ("key",)

    def __init__(self, key: Any) -> None:
        self.key = key

    def __lt__(self, other: "_QueueDesc") -> bool:
        return self.key > other.key


def _queue_page_matches(
    rows: list[Any],
    *,
    statuses: tuple[str, ...] | None,
    surface: str | None,
    entity: str | None,
    terms: list[str],
    assignee_key: str,
    verdict: str | None,
    severity: str | None,
    lo: int | None,
    hi: int | None,
    sort_field: str,
    prefs: Preferences,
    rule: str | None = None,
    closed_by: str | None = None,
) -> list[tuple[Any, str]]:
    """The ``(sort key, case id)`` of every row of one scan page that matches the
    queue filters. Pure and synchronous, so a large page runs in a worker thread.
    Only a row that a window or severity filter must judge is validated, and only
    its projected fields."""
    from ..stores.base import case_in_created_window

    extra = _queue_rule_closed_by_check(rule, closed_by, prefs)
    out: list[tuple[Any, str]] = []
    for row in rows:
        if statuses and str(_queue_value(row, "status") or "") not in statuses:
            continue
        if extra is not None and not extra(row):
            continue
        if surface and str(_queue_value(row, "source_surface") or "") != surface:
            continue
        if entity and _queue_entity(row)[1] != entity:
            continue
        if assignee_key and str(_queue_value(row, "assignee") or "").strip().casefold() != assignee_key:
            continue
        if verdict and str(_queue_value(row, "verdict") or "").strip().upper() != verdict:
            continue
        if terms:
            hay = _queue_search_haystack(row)
            if not all(term in hay for term in terms):
                continue
        validated: Case | None = row if isinstance(row, Case) else None
        if lo is not None or hi is not None:
            validated = validated or Case.model_validate(row)
            if not case_in_created_window(validated, lo, hi):
                continue
        if severity:
            validated = validated or Case.model_validate(row)
            if _queue_row_severity(validated, prefs) != severity:
                continue
        key = _queue_sort_key(row, sort_field)
        out.append((key, key[1]))
    return out


async def _queue_cases_by_id(store: Any, case_ids: list[str]) -> dict[str, Case]:
    """The full cases of one queue page, by id: the store's batch read when it has
    one (``get_many``), else bounded concurrent ``get`` calls."""
    import asyncio

    batch = getattr(store, "get_many", None)
    found: dict[str, Case] = {}
    if callable(batch):
        found = dict(await batch(case_ids))
    missing = [cid for cid in case_ids if cid not in found]
    if missing:
        gate = asyncio.Semaphore(CASE_QUEUE_FETCH_CONCURRENCY)

        async def one(case_id: str) -> tuple[str, Case | None]:
            async with gate:
                return case_id, await store.get(case_id)

        for case_id, case in await asyncio.gather(*(one(cid) for cid in missing)):
            if case is not None:
                found[case_id] = case
    return found


async def _scan_case_queue(
    state: AppState,
    *,
    statuses: tuple[str, ...] | None,
    surface: str | None,
    entity: str | None,
    terms: list[str],
    assignee: str,
    severity: str | None,
    lo: int | None,
    hi: int | None,
    sort_field: str,
    sort_order: str,
    limit: int,
    offset: int,
    verdict: str | None = None,
    rule: str | None = None,
    closed_by: str | None = None,
) -> tuple[list[Case], int]:
    """One exact pass over the case store for the queue filters → (page, total).

    Bounded by design (Round 12 final review, L1): the scan reads only
    :data:`CASE_QUEUE_SCAN_FIELDS` (a projection, never the evidence-bearing whole
    documents), keeps only the ``offset + limit`` best ``(sort key, case id)`` pairs
    while counting every match (memory is bounded by the page, not by the store),
    runs each large page's predicate work in a worker thread, and finally reads the
    requested page's full cases by id. The total stays the exact number of matching
    cases over the whole store."""
    import asyncio
    import functools
    import heapq

    prefs = state.execution_prefs
    assignee_key = assignee.casefold()
    store = state.cases
    descending = sort_order == "desc"
    keep = max(0, offset + limit) if limit > 0 else 0
    best: list[tuple[Any, str]] = []   # a heap: the WORST kept match on top
    total = 0
    cursor: Any = None
    started = False
    match = functools.partial(
        _queue_page_matches, statuses=statuses, surface=surface, entity=entity,
        terms=terms, assignee_key=assignee_key, verdict=verdict, severity=severity,
        lo=lo, hi=hi, sort_field=sort_field, prefs=prefs, rule=rule, closed_by=closed_by,
    )
    try:
        while not started or cursor is not None:
            started = True
            rows, cursor, _total, _consistency = await store.scan_page(
                limit=CASE_QUEUE_SCAN_PAGE,
                cursor=cursor,
                raw=True,
                statuses=list(statuses) if statuses else None,
                fields=list(CASE_QUEUE_SCAN_FIELDS),
            )
            rows = list(rows)
            if len(rows) >= CASE_QUEUE_OFFLOAD_AT:
                matched = await asyncio.to_thread(match, rows)
            else:
                matched = match(rows)
            total += len(matched)
            for key, case_id in matched:
                # The heap's top is the WORST kept match: for a descending order the
                # smallest key, for an ascending one the largest (``_QueueDesc``).
                item = (key if descending else _QueueDesc(key), case_id)
                if len(best) < keep:
                    heapq.heappush(best, item)
                elif best and best[0][0] < item[0]:
                    heapq.heapreplace(best, item)
        page_items = sorted(
            best, key=lambda item: item[0] if descending else item[0].key, reverse=descending,
        )[offset: offset + limit] if limit > 0 else []
        page_ids = [case_id for _key, case_id in page_items]
        found = await _queue_cases_by_id(store, page_ids) if page_ids else {}
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001 — a partial scan must never pass as exact
        logger.warning("case queue scan failed: %s", exc)
        raise HTTPException(
            status_code=503,
            detail="Could not search every case right now; try again.",
        ) from exc
    finally:
        # Round 14: an unfinished scan releases its read snapshot on EVERY exit, a
        # cancellation included (a caller's time budget, ``asyncio.wait_for``), which
        # ``except Exception`` never sees. A cluster caps its open snapshots, so a
        # stranded one (kept alive for minutes) can break every other case scan.
        if cursor is not None:
            from ..engine.case_aggregate import _close_cursor

            await _close_cursor(store, cursor)
    # A case removed between the scan and the page read is simply absent from the page.
    return [found[case_id] for case_id in page_ids if case_id in found], total


@router.get("/cases", response_model=CaseListResponse)
async def list_cases(
    status: str | None = None,
    surface: str | None = None,
    entity: str | None = None,
    limit: int = 50,
    offset: int = 0,
    from_: str | None = Query(default=None, alias="from"),
    to: str | None = Query(default=None),
    # Plain defaults, matching the filter parameters above: this route is also called
    # directly as a coroutine by in-process callers and tests, where a ``Query(...)``
    # default would arrive as the FieldInfo object itself.
    sort_field: str | None = None,
    sort_order: str | None = None,
    status_group: str | None = None,
    # Round 12 (WP-CM) — the Case Manager queue's server-side filters. Each is optional
    # and additive: a request that sends none of them is answered exactly as before.
    q: str | None = None,
    assignee: str | None = None,
    severity: str | None = None,
    # Round 12 (WP-CM) — an exact AI-verdict filter (``CASE_QUEUE_VERDICTS``), so a
    # "needs an analyst" count is a structured match rather than a text search.
    verdict: str | None = None,
    # Round 14 (SPEC §4.6.1): an exact rule value of ``Case.rule_ids`` and the
    # terminal-close owner (``CASE_QUEUE_CLOSED_BY``; the ``#/scans`` redirect, D27).
    rule: str | None = None,
    closed_by: str | None = None,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("cases", "read")),
) -> CaseListResponse | JSONResponse:
    """List cases, optionally windowed, sorted, paged and narrowed to a lifecycle group.

    The declared 200 schema is the envelope EVERY caller has always received. A request
    that engages one of ``sort_field`` / ``sort_order`` / ``status_group`` additionally
    receives the :class:`CaseListEcho` keys — ``sortable_fields``, ``sort_field``,
    ``sort_order``, ``limit_applied``, ``offset_applied``, ``max_offset`` and
    ``status_group_applied`` — describing what the server actually applied.

    They are additive and opt-in rather than always present, because a caller that sends
    none of the new parameters must keep receiving its envelope key for key. They are
    deliberately not folded into the declared response model: as optional fields there
    they would be emitted as nulls to every legacy caller, and declaring the extended
    envelope as a second response model splits the shared ``Case`` component into
    validation and serialisation variants, which changes every generated case type.

    Round 14 (SPEC §4.6.1): ``rule`` keeps the cases whose ``rule_ids`` hold that exact
    value (as stored: never trimmed or case-folded; 1 to 256 characters on one line), the
    population the rule sheet's "Show the N cases" opens and its case count measures.
    ``closed_by`` keeps terminal cases closed by ``agent``, ``analyst``,
    ``analyst_policy`` or ``system`` (the exact-aggregation engine's values, and only
    those; ``system`` also covers older rows with no recorded decider). Both are answered
    by the exact queue scan and echoed as ``rule_applied`` / ``closed_by_applied``; any
    other value is a 400. The free-text ``q`` now also matches a case's rule values.
    """
    # ADDITIVE (Round-6 #37): an OPTIONAL created_at time window so Overview widgets can
    # honor the TimeRangePicker. Default (both None) == byte-identical prior behaviour:
    # the windowless call below is untouched.
    #
    # The window is pushed into the STORE (``list_window``), not applied in Python to the
    # page we happened to fetch. That was the defect: filtering one bounded page and then
    # overwriting ``total = len(cases)`` meant a windowed total could never exceed the page
    # cap, the window only ever saw the newest rows, and every page past the first was
    # wrong — so a previous-window comparison fetch at 7d/30d could report ZERO while the
    # true count was in the hundreds, and every delta at those ranges was measured against
    # an empty set. ``window_total_exact`` reports whether the store could PROVE the total.
    #
    # ADDITIVE: an OPTIONAL server-side sort, a bounded ``offset``, and an OPTIONAL scalar
    # multi-status ``status_group``, so a drill-down can page and order the whole matching
    # population instead of re-sorting one page of the newest rows in the browser. A
    # request that sends NONE of them takes byte-identical parameters into the store and
    # gets the byte-identical base envelope back.
    search_terms = _queue_search_terms(q)
    assignee_filter = str(assignee or "").strip()[:80]
    severity_filter = str(severity or "").strip().lower() or None
    if severity_filter and severity_filter not in CASE_QUEUE_SEVERITIES:
        raise HTTPException(
            status_code=400,
            detail=(
                f"unknown severity '{severity_filter}'; "
                f"expected one of {list(CASE_QUEUE_SEVERITIES)}"
            ),
        )
    verdict_filter = str(verdict or "").strip().upper() or None
    if verdict_filter and verdict_filter not in CASE_QUEUE_VERDICTS:
        raise HTTPException(
            status_code=400,
            detail=(
                f"unknown verdict '{verdict_filter}'; "
                f"expected one of {list(CASE_QUEUE_VERDICTS)}"
            ),
        )
    # Round 14: the rule value is exact text (never trimmed or case-folded: a stored
    # rule id is matched as it is); an empty parameter means no filter.
    rule_filter = rule if rule not in (None, "") else None
    if rule_filter is not None and not _valid_rule_value(rule_filter):
        raise HTTPException(
            status_code=400,
            detail="rule must be 1 to 256 characters on one line, without control characters",
        )
    # Validated against the engine's four closer values (case-folded like the sibling
    # ``severity`` filter); anything else, ``human`` included, is refused.
    closed_by_filter = str(closed_by or "").strip().lower() or None
    if closed_by_filter and closed_by_filter not in CASE_QUEUE_CLOSED_BY:
        raise HTTPException(
            status_code=400,
            detail=(
                f"unknown closed_by '{closed_by_filter}'; "
                f"expected one of {list(CASE_QUEUE_CLOSED_BY)}"
            ),
        )
    queue_scan = bool(
        search_terms or assignee_filter or severity_filter or verdict_filter
        or rule_filter is not None or closed_by_filter
        or sort_field in CASE_QUEUE_SCAN_SORTS
    )
    extended = (
        sort_field is not None or sort_order is not None or status_group is not None
        or queue_scan
    )

    if status_group is not None:
        if status:
            # The two answer the same question with different arities. Applying both
            # would either intersect them (silently emptying the list whenever the single
            # status is outside the group) or pick a winner, and neither is something a
            # caller can predict from the request.
            raise HTTPException(
                status_code=400,
                detail="status and status_group are mutually exclusive; send one",
            )
        if status_group not in CASE_STATUS_GROUPS:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"unknown status_group '{status_group}'; "
                    f"expected one of {sorted(CASE_STATUS_GROUPS)}"
                ),
            )

    # An unsupported sort is answered in the DEFAULT order rather than refused: a sort is
    # a presentation preference, and a deployment that cannot honour one should still
    # return the operator's cases. The echo below is what keeps that honest.
    applied_sort_field = (
        sort_field
        if sort_field in CASE_SORT_FIELDS or sort_field in CASE_QUEUE_SCAN_SORTS
        else CASE_SORT_FIELD_DEFAULT
    )
    applied_sort_order = (
        sort_order if sort_order in CASE_SORT_ORDERS else CASE_SORT_ORDER_DEFAULT
    )
    # ``limit`` keeps its existing upper clamp exactly (including the pre-existing
    # tolerance of a zero/negative limit). ``offset`` gains the lower bound it never had:
    # real Elasticsearch rejects a negative ``from`` while the in-memory double slices
    # from the END of the result and returns plausible WRONG rows, so an unbounded
    # negative offset was a silent-corruption path on the default backend. The same
    # ``max(0, ...)`` the compatibility ``list_window`` already applies.
    applied_limit = min(limit, CASE_PAGE_LIMIT)
    applied_offset = max(0, offset)
    max_offset = max(0, CASE_RESULT_WINDOW - max(1, applied_limit))
    if applied_offset > max_offset:
        raise HTTPException(
            status_code=400,
            detail=(
                f"offset {applied_offset} with limit {applied_limit} crosses the "
                f"{CASE_RESULT_WINDOW}-row result window this endpoint pages within; "
                f"the deepest offset for this limit is {max_offset}"
            ),
        )

    window_total_exact: bool | None = None
    if queue_scan:
        from ..utils import relative_to_millis_strict
        from ..stores.base import status_group_statuses, window_bounds_proven

        lo = relative_to_millis_strict(from_) if from_ else None
        hi = relative_to_millis_strict(to) if to else None
        if from_ or to:
            window_total_exact = window_bounds_proven(from_, to, lo, hi)
        group_statuses = status_group_statuses(status_group)
        scan_statuses = (str(status),) if status else group_statuses
        if closed_by_filter and scan_statuses is None:
            # Only a terminal case has a closer: push that pre-filter down.
            from ..constants import TERMINAL_CASE_STATUSES

            scan_statuses = tuple(TERMINAL_CASE_STATUSES)
        cases, total = await _scan_case_queue(
            state,
            statuses=scan_statuses,
            surface=surface,
            entity=entity,
            terms=search_terms,
            assignee=assignee_filter,
            severity=severity_filter,
            verdict=verdict_filter,
            rule=rule_filter,
            closed_by=closed_by_filter,
            lo=lo,
            hi=hi,
            sort_field=applied_sort_field,
            sort_order=applied_sort_order,
            limit=applied_limit,
            offset=applied_offset,
        )
    elif from_ or to or status_group:
        # ``status_group`` is passed ONLY when one was asked for. ``list_window`` is a
        # non-abstract method a third-party repository MAY override, and unconditionally
        # handing an override a keyword it predates would break a deployment that never
        # uses the group at all.
        group_kw: dict[str, Any] = {"status_group": status_group} if status_group else {}
        cases, total, window_total_exact = await state.cases.list_window(
            created_from=from_, created_to=to,
            status=status, source_surface=surface, entity_value=entity,
            limit=applied_limit, offset=applied_offset,
            sort_field=applied_sort_field, sort_order=applied_sort_order,
            **group_kw,
        )
    else:
        cases, total = await state.cases.list(
            status=status, source_surface=surface, entity_value=entity,
            limit=applied_limit, offset=applied_offset,
            sort_field=applied_sort_field, sort_order=applied_sort_order,
        )
    # ADDITIVE (Round-7 W0.7): populate the read-time advisory bands (severity/impact/
    # urgency/priority) for the list surface. Fail-open per case — never 500 (#3).
    prefs = state.execution_prefs
    cases = [_with_advisory_bands(c, prefs) for c in cases]
    payload = CaseListResponse(cases=cases, total=total, window_total_exact=window_total_exact)
    # A request that engaged NONE of the new parameters is answered by the declared
    # response model, exactly as before — same keys, same bytes, same object for the
    # in-process callers that await this coroutine directly.
    if not extended:
        return payload
    # A request that DID engage them gets the same envelope plus the echoes. Encoding
    # through ``jsonable_encoder`` is the same step FastAPI's own response-model path
    # takes, so the shared keys are byte for byte what they always were.
    body = jsonable_encoder(payload)
    body.update(
        jsonable_encoder(
            CaseListEcho(
                sortable_fields=list(CASE_SORT_FIELDS),
                sort_field=applied_sort_field,
                sort_order=applied_sort_order,
                limit_applied=applied_limit,
                offset_applied=applied_offset,
                max_offset=max_offset,
                status_group_applied=status_group,
            )
        )
    )
    # Round 12 (WP-CM): echo the queue filters the server applied, only when asked.
    if search_terms:
        body["search_applied"] = " ".join(search_terms)
    if assignee_filter:
        body["assignee_applied"] = assignee_filter
    if severity_filter:
        body["severity_applied"] = severity_filter
    if verdict_filter:
        body["verdict_applied"] = verdict_filter
    if rule_filter is not None:
        body["rule_applied"] = rule_filter
    if closed_by_filter:
        body["closed_by_applied"] = closed_by_filter
    return JSONResponse(body)


@router.get("/cases/{case_id}", response_model=Case)
async def get_case(
    case_id: str,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("cases", "read")),
) -> Case:
    case = await state.cases.get(case_id)
    if not case:
        raise HTTPException(status_code=404, detail="Case not found")
    # ADDITIVE (Round-7 W0.7): read-time advisory bands, fail-open (never 500) (#3).
    # ``execution_prefs`` (NOT ``prefs``) — the SAME authority the list surface above
    # uses. The two diverged, so under an active demo sandbox one case could band
    # differently in the list and in its own detail view.
    return _with_advisory_bands(case, state.execution_prefs)


class CaseAction(BaseModel):
    # Lifecycle/disposition actions. Original: close | reopen | escalate |
    # confirm_fp | acknowledge. Added (F8): hold | resume | resolve |
    # set_disposition | deescalate | set_status.
    action: str
    note: str = ""
    analyst: str = "analyst"
    reason: str = ""                       # why (status_reason / timeline reason)
    # Optional, additive collaboration fields collected alongside an action (all
    # default empty/None so existing callers are unaffected). They are persisted
    # ADDITIVELY and NEVER change the deterministic status mapping below.
    resolution: str | None = None
    assignee: str | None = None
    priority: str | None = None
    tags: list[str] | None = None
    # F8 fields (additive, optional):
    disposition: str | None = None         # set_disposition target (a Disposition value)
    status: str | None = None              # set_status target (a CaseStatus value)
    # GROUND-TRUTH INTENT (additive, defaults False — absent flag = today's behaviour,
    # no migration and no backfill).
    #
    # ``disposition`` alone cannot express intent. ``case_manager.apply()`` derives a
    # disposition from the LLM verdict, so a client that reads a case and posts its
    # stored disposition straight back is echoing the MODEL, not labelling anything. A
    # value on the wire is therefore evidence of nothing: only an affirmative
    # declaration is. Set this true ONLY when a human actually chose the disposition in
    # this very interaction; when it is false the disposition is still applied to the
    # case, but the action records no analyst classification and
    # ``engine.analyst_outcomes`` will not read the case as ground truth.
    disposition_declared: bool = Field(
        default=False,
        title="The analyst chose this disposition in this action",
        description=(
            "True only when a human affirmatively selected `disposition` as part of this "
            "action. The disposition is applied either way; this flag is what makes it "
            "independent analyst evidence rather than a value echoed back from the "
            "model-derived disposition already stored on the case."
        ),
    )
    # Deprecated compatibility input retained for older API clients. The Console
    # intentionally exposes only Escalate/Escalated, never a numbered tier.
    level: int | None = Field(
        default=None,
        title="Legacy escalation compatibility value",
        description=(
            "Deprecated compatibility input for older clients. The case enters the single "
            "Escalated state; operator surfaces do not display numbered tiers."
        ),
        json_schema_extra={"deprecated": True},
    )
    # Round 14 (SPEC §4.10.15, D34): closing by hand never blocks. When an active
    # runbook run still has required steps open, a terminal move records why
    # (``case.closed_with_open_steps``). Only ``require_open_steps_reason`` (the Console
    # sends it so it can show its dialog) turns a missing reason into ``409
    # runbook_steps_open``; every other caller closes exactly as before.
    open_steps_reason: str | None = Field(
        default=None,
        max_length=500,
        title="Why the case closes with required runbook steps open",
        description="1 to 500 characters; audited on case.closed_with_open_steps.",
    )
    require_open_steps_reason: bool = Field(
        default=False,
        title="Refuse the close when required runbook steps are open and no reason is given",
        description="The Console sets it to show its close dialog; the default never blocks a close.",
    )

    @field_validator("open_steps_reason")
    @classmethod
    def _clean_open_steps_reason(cls, value: str | None) -> str | None:
        if value is None:
            return None
        text = " ".join(str(value).split())
        return text or None


# Lifecycle status reached by each action. ``None`` = the action does not move the
# lifecycle status by itself (e.g. set_disposition / acknowledge keep status). The
# deterministic close-axis from decide()/#3 is NOT touched here — these are analyst
# moves on a separate, additive layer.
_ACTION_STATUS: dict[str, CaseStatus | None] = {
    "close": CaseStatus.CLOSED,
    "confirm_fp": CaseStatus.CLOSED,
    "reopen": CaseStatus.OPEN,
    "escalate": CaseStatus.ESCALATED,
    "deescalate": CaseStatus.OPEN,
    "hold": CaseStatus.ON_HOLD,
    "resume": CaseStatus.OPEN,
    "resolve": CaseStatus.RESOLVED,
    # BUG #3 fix (R4W4): acknowledge moves a case to INVESTIGATING — a non-terminal
    # analyst status ("I've picked this up"). It is deliberately NOT in _CLOSE_ACTIONS
    # or _TERMINAL (RBAC stays cases:write), and this analyst layer never calls
    # decide() (#3): the deterministic close-axis is untouched.
    "acknowledge": CaseStatus.INVESTIGATING,
    "set_disposition": None,
    "set_status": None,                    # target carried in body.status
}

# RBAC grant required per action (resource "cases"). Terminal/close-class moves
# need cases:close; everything else needs cases:write.
_CLOSE_ACTIONS = {"close", "confirm_fp", "resolve", "reopen"}

# Actions that may carry an EXPLICIT analyst disposition in ``body.disposition``.
#
# ``set_disposition`` is the dedicated verb. ``close`` is here because the Console's
# PRIMARY close — "Close with a disposition" — posts ``action="close"`` with the
# disposition the analyst picked. That value used to be parsed off the wire and then
# silently discarded: only ``set_disposition``/``confirm_fp`` ever assigned
# ``case.disposition``, so the main close path could never produce analyst-confirmed
# ground truth (``engine/analyst_outcomes``) and the precedent corpus it feeds could
# never be refreshed. Assigning it here is what the dialog has always claimed to do.
#
# This is the analyst layer only: it never calls ``decide()`` and never changes the
# deterministic close-axis (#3). An action NOT listed here still ignores the field, so
# no lifecycle verb silently acquires classification power.
#
# APPLYING the disposition and CLASSIFYING the case are two different things. Every
# action here applies it; only :data:`_SELF_DECLARING_ACTIONS` — or an explicit
# ``disposition_declared`` — classifies. See ``_perform_case_action``.
#
# ``resolve`` (Round 12, WP-CM / SPEC D15): resolving a case is a terminal move, and a
# terminal move must be able to capture the investigative outcome. Before this, "Mark
# resolved" (single and bulk) could only leave the triage-time disposition that
# ``case_manager.apply()`` mapped from the model's verdict — for a NEEDS_HUMAN verdict
# that is ``undetermined`` — which is exactly the "Undetermined after I resolved it as a
# false positive" report. Same apply-vs-classify split as ``close``: the value is applied
# when sent, and it CLASSIFIES only on an affirmative ``disposition_declared``.
_DISPOSITION_ACTIONS = {"set_disposition", "close", "resolve"}

# Actions whose VERB is itself the analyst's declaration, so they need no separate
# intent flag. ``set_disposition`` exists for no other purpose than classifying a case
# and the wire rejects it without a disposition, so performing it IS the declaration —
# and it is already in ``analyst_outcomes.CLASSIFICATION_ACTIONS``, so this only keeps
# the history entry self-describing.
#
# ``close`` is deliberately ABSENT: closing is a lifecycle move that most analysts
# perform without classifying anything, and the disposition it carries may simply be
# the one ``case_manager.apply()`` derived from the model's own verdict, read off the
# case and posted straight back. For ``close`` the classification is recorded only on
# an affirmative ``disposition_declared``.
_SELF_DECLARING_ACTIONS = {"set_disposition"}

# Terminal lifecycle statuses (a case here is DONE). A backward move out of a
# terminal status is only allowed via an explicit reopen.
_TERMINAL = {CaseStatus.CLOSED, CaseStatus.RESOLVED}

# The ONE forward move between terminal statuses: RESOLVED means "worked to
# completion, pending final close", so the dedicated close verbs may take it to
# CLOSED. Every other move out of a terminal status still needs ``reopen``; the
# generic ``set_status`` can never reach CLOSED; CLOSED → RESOLVED stays blocked.
# Analyst layer only (RBAC: both verbs already need ``cases:close``); never decide() (#3).
_FINAL_CLOSE_ACTIONS = frozenset({"close", "confirm_fp"})


def _guard_transition(action: str, current: CaseStatus, target: CaseStatus | None) -> None:
    """Reject illegal lifecycle moves (e.g. CLOSED→NEW without reopen). Allows
    reopen explicitly out of a terminal status, the final close of a RESOLVED case
    through ``close``/``confirm_fp``, and same-status no-ops."""
    if target is None or target == current:
        return
    if (
        current == CaseStatus.RESOLVED
        and target == CaseStatus.CLOSED
        and action in _FINAL_CLOSE_ACTIONS
    ):
        return
    # Moving OUT of a terminal status is otherwise only legal via reopen.
    if current in _TERMINAL and action not in ("reopen",):
        raise HTTPException(
            status_code=400,
            detail=f"illegal transition: {current.value} → {target.value}; reopen the case first",
        )
    # Never let an analyst move a non-investigated NEEDS_HUMAN/None verdict to a
    # CLOSED via a generic set_status sidestep — close must go through close/resolve.
    if target == CaseStatus.CLOSED and action == "set_status":
        raise HTTPException(
            status_code=400,
            detail="use the close action to close a case",
        )


def _case_action_grant(action: str, target: CaseStatus | None = None) -> str:
    """The ``cases`` action grant required to perform lifecycle ``action`` — close-
    class moves need ``cases:close``, everything else ``cases:write``. Shared by the
    single-case endpoint and the bulk endpoint so RBAC is decided in ONE place.

    TARGET-AWARE: ``set_status`` (and its bulk form) is a generic status setter, so a
    ``cases:write``-only analyst must NOT be able to drive a case to a TERMINAL/close-
    axis status (RESOLVED/CLOSED) through it — that is exactly the ``cases:close``
    grant the explicit close/resolve actions require. When ``set_status`` (or any
    non-close action) targets a terminal status, the required grant is upgraded to
    ``cases:close``. The deterministic #3 close-axis is unaffected (this is the human
    analyst path; it never calls ``decide()``)."""
    if action in _CLOSE_ACTIONS:
        return "close"
    # A generic set_status (or any non-close action) reaching a terminal status is a
    # close-axis move → require cases:close, not cases:write.
    if target is not None and target in _TERMINAL:
        return "close"
    return "write"


def _grant_for_body(body: CaseAction) -> str:
    """Resolve the required ``cases`` grant for a (possibly target-bearing) action.

    Maps the action to its lifecycle target (``set_status`` carries the target in
    ``body.status``) and delegates to :func:`_case_action_grant` so the single-case
    and bulk endpoints upgrade a terminal-reaching ``set_status`` to ``cases:close``
    in EXACTLY one place. A malformed ``set_status`` target is left to the action
    handler to reject (400); for grant purposes it is treated as a non-terminal
    write."""
    target = _ACTION_STATUS.get(body.action)
    if body.action == "set_status" and body.status:
        try:
            target = CaseStatus(body.status)
        except ValueError:
            target = None
    return _case_action_grant(body.action, target)


# Case tag bounds: ``CASE_TAG_MAX_CHARS`` / ``CASE_TAG_MAX_COUNT`` live in
# ``engine/case_tags.py`` (imported above) and the web console mirrors them in
# ``webui/src/lib/tags.ts`` under the same names.
def _merge_case_tags(existing: list[str], incoming: list[Any], *, replace: bool) -> list[str]:
    """Trim and de-duplicate case tags; refuse (422) what the bounds refuse.

    A NEW tag over 40 characters, or new tags that would take the case past 25, answer
    422 with a detail that says why. Nothing is cut and nothing is dropped: a shortened
    label is a different tag, and a tag left off silently is a change the analyst asked
    for and did not get. A tag the case already carries passes unchanged.
    ``replace`` takes ``incoming`` as the whole list (``/tags``); otherwise it is merged
    after ``existing`` (a lifecycle action's additive tags)."""
    try:
        return merge_case_tags(existing, incoming, replace=replace)
    except CaseTagError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.post("/cases/{case_id}/action")
async def case_action(
    case_id: str,
    body: CaseAction,
    state: AppState = Depends(get_state),
    request: Request = None,  # type: ignore[assignment]
) -> dict[str, Any]:
    if body.action not in _ACTION_STATUS:
        raise HTTPException(status_code=400, detail=f"Unknown action: {body.action}")

    # RBAC: close-class moves need cases:close, the rest cases:write. A strict
    # no-op when auth is disabled (the no-auth default), so back-compat holds.
    # ``request`` is always present over HTTP; it is None only for direct in-process
    # test calls, where RBAC would be a no-op anyway.
    user = None
    if request is not None:
        from .deps import _enforce

        user = await _enforce(request, "cases", _grant_for_body(body))
    actor = getattr(user, "username", "") or body.analyst or "analyst"
    return await _perform_case_action(case_id, body, actor, state, context=_request_audit_context(request))


def _request_audit_context(request: Request | None) -> Any:
    """The request's audit context (client, session, role, request id) for the rows a
    case action writes, or ``None`` for an in-process call without a request."""
    if request is None:
        return None
    from ..audit.context import audit_context

    return audit_context(request)


async def _perform_case_action(
    case_id: str, body: CaseAction, actor: str, state: AppState, batch_id: str = "",
    via: str | None = None, context: Any = None,
) -> dict[str, Any]:
    """Apply ONE human lifecycle action to ONE case — the SINGLE source of truth for
    the analyst-action path (used by the single-case endpoint AND the bulk endpoint).

    #3-safe: this is the HUMAN analyst layer ONLY. It NEVER calls
    ``case_manager.decide()`` and never runs the deterministic auto-close path; the
    close-axis truth table is untouched. Caller has already done the RBAC check +
    resolved ``actor``. Each call audits the transition individually (#2).

    ``batch_id`` marks the cases that one bulk action touched as ONE operator
    transaction. A bulk action is a single human decision applied to hundreds of cases,
    and the bounded precedent window has to be able to tell that apart from hundreds of
    independent decisions — otherwise one bulk action buys the whole window. Stamped
    only when supplied, so a single-case action's history entry is unchanged.

    ``via`` (Round 14, D34) names how a close with required runbook steps open was
    made (``bulk`` for the bulk endpoint and the ``case_lifecycle`` job, ``proposal``
    for an approved proposal); a single action derives ``console`` or ``api`` from
    ``require_open_steps_reason``. A bulk close never fails an item for open steps.
    ``context`` is the request's audit context, carried onto the
    ``case.closed_with_open_steps`` row (a job has none). The runbook state is read
    only on this human path: automatic closes never read it and ``decide()`` /
    ``AutoClosePolicy`` are untouched (#3)."""
    case = await state.cases.get(case_id)
    if not case:
        raise HTTPException(status_code=404, detail="Case not found")
    if body.action not in _ACTION_STATUS:
        raise HTTPException(status_code=400, detail=f"Unknown action: {body.action}")
    # Checked before anything changes, so a refused tag leaves the case untouched.
    merged_tags = (
        _merge_case_tags(case.tags, body.tags, replace=False) if body.tags is not None else None
    )
    previous_tags = list(case.tags or [])

    prev_status = case.status

    # Resolve the lifecycle target.
    target = _ACTION_STATUS[body.action]
    if body.action == "set_status":
        if not body.status:
            raise HTTPException(status_code=400, detail="set_status requires a status")
        try:
            target = CaseStatus(body.status)
        except ValueError:
            raise HTTPException(status_code=400, detail=f"unknown status: {body.status}")
    if body.action == "escalate" and body.level is not None:
        case.escalation_level = max(int(body.level), 1)
    elif body.action == "escalate":
        case.escalation_level = max(case.escalation_level, 1)
    elif body.action == "deescalate":
        case.escalation_level = 0
    # BUG #3 (R4W4): stamp the acknowledgement instant for SLA/MTTA derivation. Note
    # the Case model asymmetry — created_at/updated_at are ISO STRINGS, but
    # acknowledged_at is a ``datetime | None`` (the SLA-interval anchors), so use a
    # datetime here, only on the first acknowledge (idempotent).
    if body.action == "acknowledge" and case.acknowledged_at is None:
        case.acknowledged_at = now_utc()

    _guard_transition(body.action, prev_status, target)

    # The request is validated in full before the runbook check below, so a request
    # that can never succeed is answered with its own 400, never with the close
    # dialog's 409 (a reason would not make it valid). Nothing is applied here.
    if body.action == "set_disposition" and not body.disposition:
        raise HTTPException(status_code=400, detail="set_disposition requires a disposition")
    requested_disposition: Disposition | None = None
    if body.action in _DISPOSITION_ACTIONS and body.disposition:
        try:
            requested_disposition = Disposition(body.disposition)
        except ValueError:
            raise HTTPException(status_code=400, detail=f"unknown disposition: {body.disposition}")
    # "Mark duplicate" (SPEC §4.10.15): a terminal move that carries the duplicate
    # disposition. Decided once from the request, so the 409 exemption and the audit
    # row's ``via`` and note always agree, whatever the case carried before.
    marks_duplicate = requested_disposition == Disposition.DUPLICATE

    # Round 14 (D34): the first terminal move of a case with required runbook steps
    # still open. Read before anything changes so a 409 leaves the case untouched; an
    # unreadable run store never blocks a close (``None``).
    open_steps = None
    if target is not None and target in _TERMINAL and prev_status not in _TERMINAL:
        from ..engine import runbook_runs

        open_steps = await runbook_runs.open_required_steps(state, case_id)
        if (open_steps and body.require_open_steps_reason and not body.open_steps_reason
                and via != "bulk" and not marks_duplicate):
            raise HTTPException(status_code=409, detail={
                "code": "runbook_steps_open",
                "message": (
                    f"{len(open_steps)} required runbook "
                    f"{'step is' if len(open_steps) == 1 else 'steps are'} still open. "
                    "Say why you are closing the case."
                ),
                "required_open": len(open_steps),
                "steps": [step.model_dump(mode="json") for step in open_steps],
            })

    # A disposition supplied with the action. ``set_disposition`` requires one; ``close``
    # accepts one (the Console's unified Close-with-disposition flow sends it).
    #
    # APPLY and CLASSIFY are separated on purpose. Applying is unconditional: the case
    # carries the disposition the caller sent, which is what the dialog has always
    # claimed to do. Classifying is what makes ``engine.analyst_outcomes`` treat that
    # disposition as INDEPENDENT ground truth, and the presence of the field cannot
    # establish it — ``case_manager.apply()`` derives a disposition from the LLM verdict,
    # so a client echoing the stored value back is quoting the model to itself. Only the
    # verb (``set_disposition``) or an affirmative ``disposition_declared`` says a human
    # chose it. Absent both, the case is applied-but-unlabelled, exactly as before this
    # path existed.
    #
    # One exception keeps the analyst's word final: an UNDECLARED value never replaces a
    # disposition an analyst explicitly classified and the case still carries
    # (``standing_analyst_disposition``). It may be the model-derived value read off the
    # case before the analyst classified it and posted back, and applying it would turn
    # the analyst's label into the model's while the classification entry still vouches
    # for it. The lifecycle move itself still happens; only the echo is not applied.
    classified_disposition = ""
    if requested_disposition is not None:
        if body.action in _SELF_DECLARING_ACTIONS or body.disposition_declared:
            case.disposition = requested_disposition
            classified_disposition = requested_disposition.value
        elif standing_analyst_disposition(case) is None:
            case.disposition = requested_disposition

    # confirm_fp is its own classification: the verb IS the analyst's declaration (it is
    # in ``analyst_outcomes.CLASSIFICATION_ACTIONS``), and the newest decision wins. It
    # therefore replaces every non-false-positive disposition, including the
    # ``true_positive`` that ``case_manager.apply()`` mapped from a TRUE_POSITIVE verdict
    # and any earlier analyst value, and keeps ``benign``, which is the analyst's
    # false-positive-class refinement. Stamping the value on the history entry makes the
    # entry self-describing, so ``caseOutcome``, the facts rail and
    # ``analyst_confirmed_outcome`` all read the same false-positive class.
    if body.action == "confirm_fp":
        if case.disposition not in (Disposition.FALSE_POSITIVE, Disposition.BENIGN):
            case.disposition = Disposition.FALSE_POSITIVE
        classified_disposition = case.disposition.value

    # Apply the lifecycle status move (analyst layer — NOT decide()/#3).
    if target is not None:
        case.status = target
    case.decision_by = DecisionBy.ANALYST
    case.updated_at = iso_now()
    reason = (body.reason or body.note or "").strip()[:500]
    if reason and body.action in ("hold", "resolve", "set_status"):
        case.status_reason = reason

    # --- Additive optional fields (persisted without touching status logic) -----
    # assignee → set the case owner when provided (non-empty).
    assigned = None
    if body.assignee is not None:
        assigned = str(body.assignee).strip()[:80]
        # The same owner again (trimmed, any letter case) changes nothing and records
        # no new assignment time.
        assigned = assigned if _owner_changed(case.assignee, assigned) else None
        if assigned is not None:
            case.assignee = assigned
    # tags → merge into the case's tags (trim, de-dupe, bounded; the same rules as
    # the dedicated /tags route, checked above by ``_merge_case_tags``).
    if merged_tags is not None:
        case.tags = merged_tags

    # Record the lifecycle transition on the append-only status timeline.
    if case.status != prev_status:
        case.status_history.append(StatusHistoryEntry(
            from_status=(prev_status.value if prev_status else ""),
            to_status=case.status.value,
            by=actor,
            at=case.updated_at,
            reason=reason,
        ))

    # Build the history entry, recording resolution/priority when supplied (they
    # have no dedicated Case field, so the audited history entry is their home).
    entry: dict[str, Any] = {
        "ts": case.updated_at, "event": "analyst_action", "action": body.action,
        "analyst": actor, "note": body.note,
    }
    if batch_id:
        entry["batch"] = batch_id
    if classified_disposition:
        # The DECLARED classification made by THIS action (see the apply/classify split
        # above — set only for a self-declaring verb or an affirmative
        # ``disposition_declared``). The action token alone cannot carry it, because the
        # primary close posts ``action="close"``, which is not a classification verb, so
        # ``engine.analyst_outcomes.is_classification_entry`` reads this key instead.
        # Append-only (#2): a new key on a NEW entry; no existing history row is
        # rewritten and no past case is relabelled.
        entry[CLASSIFIED_DISPOSITION_KEY] = classified_disposition
    if body.resolution is not None:
        entry["resolution"] = str(body.resolution)
    if body.priority is not None:
        entry["priority"] = str(body.priority)
    if assigned is not None:
        # A new owner set by this action: its time, for the "my cases" starter.
        entry["assignee"] = assigned
    case.history.append(entry)
    await state.cases.save(case)
    # Append-only audit of the lifecycle transition (#2) — best-effort.
    try:
        await state.audit.record(
            action_type=ActionType.STATUS, surface="case", actor=actor, case_id=case_id,
            result_summary=(
                f"action={body.action} status {prev_status.value if prev_status else '?'}"
                f"→{case.status.value} disposition={case.disposition.value if case.disposition else 'none'}"
                + (f" reason={reason}" if reason else "")
                # APPENDED at the end (never reordered — this summary is read
                # positionally elsewhere): whether the analyst classified the case in
                # this very action, which is what makes the disposition above
                # independent evidence rather than an inherited value.
                + (f" classified={classified_disposition}" if classified_disposition else "")
            ),
        )
    except Exception as exc:  # noqa: BLE001 — audit is best-effort, never blocks the action
        logger.warning("Status audit failed for %s: %s", case_id, exc)
    # Round 14 (D34, SPEC §4.10.15): a person closed with required runbook steps open,
    # so record why (#2), whoever closed and however; the close itself already stands.
    if open_steps and case.status in _TERMINAL:
        from ..engine import runbook_runs

        # A reason the person gave is always recorded, a duplicate included.
        how = via or ("console" if (body.require_open_steps_reason or marks_duplicate) else "api")
        await runbook_runs.record_closed_with_open_steps(
            state, case, actor=actor, via=how, reason=body.open_steps_reason,
            steps=open_steps, note="Duplicate" if marks_duplicate else None, context=context,
        )
    # Round 14 (SPEC §4.10.4): a human move that leaves the case needing a person
    # (reopen, escalate, a status change) or changes its tags is a re-evaluation
    # trigger: the matching runbook attaches when the case has none yet, or a more
    # specific one does. Never raises and never changes the action's outcome.
    tags_changed = merged_tags is not None and list(merged_tags) != list(previous_tags)
    if case.status not in _TERMINAL and (case.status != prev_status or tags_changed):
        from ..engine import runbook_runs

        await runbook_runs.reevaluate_case(state, case, trigger=f"action:{body.action}")
    # On close / confirm-FP, index the resolved case as RAG baseline memory (C3-5)
    # so future investigations of similar entities learn from this decision + note.
    # Fail-safe: a RAG/embedding failure must NEVER break the analyst's action.
    if body.action in ("close", "confirm_fp"):
        try:
            await state.rag_service.index_resolved_case(case, note=body.note)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Resolved-case RAG index failed for %s: %s", case_id, exc)
        # HITL: draft a PENDING suppression proposal from a closed false positive.
        # Fail-safe (own try/except) so the proposer can NEVER break the analyst's
        # close — it only WRITES a pending Proposal; nothing auto-applies.
        try:
            from ..agents.proposer import draft_suppression_proposal

            proposal_source = state.log_source
            if state.demo_active:
                proposal_source = (
                    state.demo_source_connector(case.source_id or "")
                    or state.demo_source_connector("demo-splunk")
                )
            proposal = await draft_suppression_proposal(
                case, source=proposal_source, prefs=state.execution_prefs
            )
            if proposal is not None:
                await state.proposals.add(proposal)
                await state.audit.record(
                    action_type=ActionType.PROPOSAL, surface="case", actor="agent",
                    case_id=case_id,
                    result_summary=(
                        f"drafted suppression proposal {proposal.id} "
                        f"({proposal.payload.get('field')}=={proposal.payload.get('value')}) "
                        f"confidence={proposal.confidence}"
                    ),
                )
        except Exception as exc:  # noqa: BLE001 — proposing must never break the close
            logger.warning("Suppression proposal draft failed for %s: %s", case_id, exc)
    # Fire-and-forget notification on a lifecycle transition (escalate / close /
    # resolve). Detached + fully swallowed so a send can NEVER block or alter the
    # analyst action (#3). A no-op unless notifications are enabled + a trigger matches.
    try:
        from ..notifications.dispatch import (
            TRIGGER_CLOSED, TRIGGER_ESCALATED, NotificationService,
        )

        _trig = None
        if body.action == "escalate":
            _trig = TRIGGER_ESCALATED
        elif body.action in ("close", "confirm_fp", "resolve"):
            _trig = TRIGGER_CLOSED
        notifier: NotificationService | None = getattr(state, "notifications", None)
        if _trig and notifier is not None and not state.demo_active:
            state.spawn_mutation_task(
                notifier.dispatch(case, _trig),
                name=f"case-lifecycle-notify:{case_id}",
            )
    except Exception as exc:  # noqa: BLE001 — notifications never affect the action
        logger.debug("lifecycle notification scheduling skipped for %s: %s", case_id, exc)
    return _case_view(case, state)


class BulkCaseAction(CaseAction):
    """A :class:`CaseAction` applied to many cases at once. ``ids`` is the set of
    target case ids; the action/payload fields are inherited verbatim so a bulk move
    is IDENTICAL to N single-case moves."""

    ids: list[str] = Field(default_factory=list)


@router.post("/cases/bulk")
async def cases_bulk_action(
    body: BulkCaseAction,
    state: AppState = Depends(get_state),
    request: Request = None,  # type: ignore[assignment]
) -> dict[str, Any]:
    """Apply ONE human lifecycle action to MANY cases.

    #3-safe: each id is run through the EXACT same code path as the single-case
    ``POST /api/cases/{id}/action`` (``_perform_case_action``) — the HUMAN analyst
    layer. It NEVER invokes ``case_manager.decide()`` and never runs the
    deterministic auto-close path; closing here is the analyst close action, not an
    LLM auto-close. RBAC is enforced ONCE up front (cases:close for close-class
    moves, cases:write otherwise — same grant as the single endpoint). Each case is
    applied + AUDITED individually (#2). Partial-failure tolerant: returns
    ``{results:[{id, ok, error?}]}`` with a per-id outcome (a bad/missing id or an
    illegal transition fails only that id, never the batch)."""
    if body.action not in _ACTION_STATUS:
        raise HTTPException(status_code=400, detail=f"Unknown action: {body.action}")
    ids = [str(i).strip() for i in (body.ids or []) if str(i).strip()]
    if not ids:
        raise HTTPException(status_code=400, detail="ids must be a non-empty list")
    if len(ids) > 500:
        raise HTTPException(status_code=400, detail="too many ids (max 500)")

    # RBAC: decide the grant from the action (the SAME rule as the single endpoint),
    # enforce ONCE for the whole batch. No-op when auth is disabled.
    user = None
    if request is not None:
        from .deps import _enforce

        user = await _enforce(request, "cases", _grant_for_body(body))
    actor = getattr(user, "username", "") or body.analyst or "analyst"

    # The per-case payload is the bulk body minus ``ids`` — i.e. a plain CaseAction
    # applied identically to each target.
    single = CaseAction(**{k: v for k, v in body.model_dump().items() if k != "ids"})

    # ONE transaction id for the whole bulk move, stamped onto every history entry it
    # writes. This is what lets the bounded precedent window treat a bulk action as the
    # single operator decision it is instead of N independent ones; see
    # ``PrecedentWindowConfig.max_transaction_fraction``.
    batch_id = new_id("bulk-")
    bulk_context = _request_audit_context(request)

    results: list[dict[str, Any]] = []
    seen: set[str] = set()
    for cid in ids:
        if cid in seen:
            continue  # de-dupe so a repeated id isn't applied (and audited) twice
        seen.add(cid)
        try:
            await _perform_case_action(cid, single, actor, state, batch_id=batch_id, via="bulk",
                                       context=bulk_context)
            results.append({"id": cid, "ok": True})
        except HTTPException as exc:
            results.append({"id": cid, "ok": False, "error": str(exc.detail)})
        except Exception as exc:  # noqa: BLE001 — one bad case never breaks the batch
            logger.warning("bulk action %s failed for %s: %s", body.action, cid, exc)
            results.append({"id": cid, "ok": False, "error": "internal error"})
    return {"results": results}


class FeedbackBody(BaseModel):
    analyst: str = ""
    assessment: str = ""                  # agree | partial | disagree
    accuracy: float = 0.0
    reasoning_quality: float = 0.0
    action_appropriateness: float = 0.0
    actual_outcome: FeedbackOutcome = FeedbackOutcome.UNKNOWN
    time_saved_minutes: int = 0
    comment: str = ""


class CommentBody(BaseModel):
    author: str = ""
    body: str = ""


class TagsBody(BaseModel):
    tags: list[str] = Field(default_factory=list)
    analyst: str = ""


class AssignBody(BaseModel):
    assignee: str = ""
    analyst: str = ""


def _owner_changed(previous: str | None, new: str | None) -> bool:
    """True when ``new`` names a different case owner from ``previous``: trimmed and
    compared without case, as usernames are (the user store lower-cases them)."""
    return (previous or "").strip().casefold() != (new or "").strip().casefold()


@router.post("/cases/{case_id}/feedback")
async def case_feedback(
    case_id: str,
    body: FeedbackBody,
    state: AppState = Depends(get_state),
    request: Request = None,  # type: ignore[assignment]
) -> dict[str, Any]:
    """Record an authenticated analyst's grade of the AI verdict.

    ``body.analyst`` remains a compatibility input for auth-disabled/direct-test
    callers. Over HTTP with auth enabled, the persisted analyst and audit actor always
    come from the verified principal; a client cannot spoof another operator. The
    narrow ``cases:write`` grant is enforced inline so assigned custom roles work the
    same way as every other case mutation.
    """
    user = None
    if request is not None:
        from .deps import _enforce

        user = await _enforce(request, "cases", "write")
    actor = getattr(user, "username", "") or body.analyst or "analyst"
    case = await state.cases.get(case_id)
    if not case:
        raise HTTPException(status_code=404, detail="Case not found")
    entry = FeedbackEntry(
        analyst=actor,
        assessment=body.assessment,
        accuracy=max(0.0, min(1.0, body.accuracy)),
        reasoning_quality=max(0.0, min(1.0, body.reasoning_quality)),
        action_appropriateness=max(0.0, min(1.0, body.action_appropriateness)),
        actual_outcome=body.actual_outcome.value,
        time_saved_minutes=max(0, int(body.time_saved_minutes)),
        comment=body.comment,
        ai_verdict=case.verdict.value if case.verdict else "",
        ai_confidence=case.confidence,
    )
    case.feedback.append(entry)
    case.updated_at = iso_now()
    await state.cases.save(case)
    await state.audit.record(
        action_type=ActionType.FEEDBACK, surface="case", actor=actor,
        case_id=case_id,
        result_summary=f"assessment={entry.assessment} outcome={entry.actual_outcome} "
                       f"accuracy={entry.accuracy}",
    )
    # Analyst feedback can supply ground truth after a case was auto-closed. Refresh
    # the institutional RAG projection only for terminal cases; the RAG service
    # independently rejects unknown/model-only outcomes, so feedback collection can
    # never promote an unconfirmed verdict into durable learning evidence.
    if case.status in (CaseStatus.CLOSED, CaseStatus.RESOLVED):
        try:
            await state.rag_service.index_resolved_case(case, note=body.comment)
        except Exception as exc:  # noqa: BLE001 — feedback must survive RAG outages
            logger.warning("Feedback RAG refresh failed for %s: %s", case_id, exc)
    return _case_view(case, state)


@router.post("/cases/{case_id}/comment")
async def case_comment(
    case_id: str,
    body: CommentBody,
    state: AppState = Depends(get_state),
    request: Request = None,  # type: ignore[assignment]
) -> dict[str, Any]:
    # RBAC: commenting needs cases:comment. No-op when auth off; ``request`` is None
    # only for direct in-process test calls, where RBAC would be a no-op anyway.
    if request is not None:
        from .deps import _enforce

        await _enforce(request, "cases", "comment")
    case = await state.cases.get(case_id)
    if not case:
        raise HTTPException(status_code=404, detail="Case not found")
    if not body.body.strip():
        raise HTTPException(status_code=400, detail="comment body is required")
    case.comments.append(CaseComment(author=body.author, body=body.body.strip()[:4000]))
    case.updated_at = iso_now()
    await state.cases.save(case)
    await state.audit.record(
        action_type=ActionType.COLLAB, surface="case", actor=body.author or "analyst",
        case_id=case_id, result_summary="comment added",
    )
    return _case_view(case, state)


@router.post("/cases/{case_id}/tags")
async def case_tags(
    case_id: str,
    body: TagsBody,
    state: AppState = Depends(get_state),
    request: Request = None,  # type: ignore[assignment]
) -> dict[str, Any]:
    # RBAC: editing tags needs cases:write. No-op when auth off; ``request`` is None
    # only for direct in-process test calls, where RBAC would be a no-op anyway.
    if request is not None:
        from .deps import _enforce

        await _enforce(request, "cases", "write")
    case = await state.cases.get(case_id)
    if not case:
        raise HTTPException(status_code=404, detail="Case not found")
    # De-dupe, trim and bound the count; a new tag over the length limit is refused,
    # never cut (``_merge_case_tags``).
    previous_tags = list(case.tags or [])
    case.tags = _merge_case_tags(case.tags, body.tags, replace=True)
    case.updated_at = iso_now()
    await state.cases.save(case)
    await state.audit.record(
        action_type=ActionType.COLLAB, surface="case", actor=body.analyst or "analyst",
        case_id=case_id, result_summary=f"tags set ({len(case.tags)})",
    )
    # Round 14 (SPEC §4.10.4): a tag change is a re-evaluation trigger (a runbook may
    # apply by tag). Never raises and never changes the tag write.
    if list(case.tags or []) != previous_tags:
        from ..engine import runbook_runs

        await runbook_runs.reevaluate_case(state, case, trigger="tags")
    return _case_view(case, state)


@router.post("/cases/{case_id}/assign")
async def case_assign(
    case_id: str,
    body: AssignBody,
    state: AppState = Depends(get_state),
    request: Request = None,  # type: ignore[assignment]
) -> dict[str, Any]:
    # RBAC: reassigning needs cases:assign. No-op when auth off; ``request`` is None
    # only for direct in-process test calls, where RBAC would be a no-op anyway.
    if request is not None:
        from .deps import _enforce

        await _enforce(request, "cases", "assign")
    case = await state.cases.get(case_id)
    if not case:
        raise HTTPException(status_code=404, detail="Case not found")
    new_owner = body.assignee.strip()[:80]
    changed = _owner_changed(case.assignee, new_owner)
    if changed:
        case.assignee = new_owner
    case.updated_at = iso_now()
    # The assignment time, on the case's append-only history (Round 13 polish PB3): the
    # "my cases" starter states how long the oldest of a caller's cases has been theirs
    # only from this record ("Oldest assigned …"), never from the case's age. Recorded
    # only when the owner changes: assigning a case to its current owner (Assign again,
    # or a bulk assign over cases the person already holds) keeps the earlier time.
    if changed:
        case.history.append({"ts": case.updated_at, "event": "assigned", "assignee": case.assignee,
                             "analyst": body.analyst or "analyst"})
    await state.cases.save(case)
    await state.audit.record(
        action_type=ActionType.COLLAB, surface="case", actor=body.analyst or "analyst",
        case_id=case_id, result_summary=f"assigned to {case.assignee or '(unassigned)'}",
    )
    return _case_view(case, state)


@router.get("/cases/{case_id}/export")
async def case_export(
    case_id: str, format: str = "json", state: AppState = Depends(get_state)
) -> dict[str, Any]:
    """Export a case for handoff/ticketing as JSON or a Markdown report. Returns
    ``{filename, content_type, content}`` so the UI can trigger a download."""
    case = await state.cases.get(case_id)
    if not case:
        raise HTTPException(status_code=404, detail="Case not found")
    fmt = (format or "json").lower()
    if fmt == "md" or fmt == "markdown":
        return {
            "filename": f"{case_id}.md",
            "content_type": "text/markdown",
            "content": _case_markdown(case),
        }
    if fmt == "json":
        import json as _json

        return {
            "filename": f"{case_id}.json",
            "content_type": "application/json",
            "content": _json.dumps(case.model_dump(mode="json"), indent=2, default=str),
        }
    raise HTTPException(status_code=400, detail=f"unsupported format: {format}")


def _case_runbook_label(case) -> str:
    """The runbook line of the case Markdown report (Round 14 SPEC §4.10.18): the
    Published runbook whose guidance the investigator received and its version
    (``Case.runbook_id``), else the procedure id an earlier investigation recorded
    (``Case.playbook_id``, kept readable and never rewritten), shown with the built-in
    runbook that replaced it when it was a retired bundled procedure
    (``LEGACY_BUNDLED_RUNBOOK_MAP``, §4.10.16), else "none"."""
    from ..engine.runbook_model import resolve_legacy_runbook_id

    runbook_id = str(getattr(case, "runbook_id", None) or "").strip()
    if runbook_id:
        version = getattr(case, "runbook_version", None)
        return f"{runbook_id} v{version}" if isinstance(version, int) and version > 0 else runbook_id
    legacy = str(getattr(case, "playbook_id", "") or "").strip()
    if not legacy:
        return "none"
    successor = resolve_legacy_runbook_id(legacy)
    if successor:
        return f"{successor} (recorded as {legacy}, an earlier procedure)"
    return f"{legacy} (an earlier procedure)"


def _case_markdown(case) -> str:
    """A human-readable Markdown incident report from a case (pure serialisation)."""
    lines = [
        f"# Case {case.case_id}",
        "",
        f"- **Title:** {case.title or '—'}",
        f"- **Entity:** {case.entity.type.value} = {case.entity.value}",
        f"- **Verdict:** {case.verdict.value if case.verdict else '—'} "
        f"(confidence {round(case.confidence, 2)})",
        f"- **Status:** {case.status.value} · decided by {case.decision_by.value if case.decision_by else '—'}",
        f"- **Risk score:** {round(case.risk_score, 1)}",
        f"- **Persona:** {case.agent_persona or 'generalist'} · **Runbook:** {_case_runbook_label(case)}",
        f"- **Rules:** {', '.join(case.rule_ids) or '—'}",
        f"- **MITRE:** {', '.join(case.mitre) or '—'}",
        f"- **Assignee:** {case.assignee or '—'} · **Tags:** {', '.join(case.tags) or '—'}",
        f"- **Created:** {case.created_at} · **Updated:** {case.updated_at}",
        "",
        "## Recommended action",
        case.recommended_action or "—",
        "",
        "## Reproduce query",
        f"```\n{case.reproduce_query or '—'}\n```",
        "",
        "## Evidence",
    ]
    if case.evidence:
        for e in case.evidence:
            lines.append(f"- {e.summary}" + (f"  (events: {', '.join(e.event_ids)})" if e.event_ids else ""))
    else:
        lines.append("—")
    if case.comments:
        lines += ["", "## Comments"]
        lines += [f"- _{c.ts}_ **{c.author or 'analyst'}**: {c.body}" for c in case.comments]
    if case.feedback:
        lines += ["", "## Analyst feedback"]
        for f in case.feedback:
            lines.append(
                f"- _{f.ts}_ {f.analyst or 'analyst'}: {f.assessment} "
                f"(outcome {f.actual_outcome or '—'}, accuracy {f.accuracy})"
            )
    return "\n".join(lines)


@router.post("/cases/{case_id}/investigate")
async def case_investigate(
    case_id: str,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("cases", "reinvestigate")),
) -> dict[str, Any]:
    """Human-triggered (re-)investigation of a stored case (C3-4).

    Rebuilds the cluster from the case — preferring an exact id-based re-query,
    falling back to a config-windowed entity re-query — then re-runs the SAME
    shared pipeline with ``force=True`` so an already-investigated OPEN case is
    re-investigated in place. The case's ORIGINAL provenance (``source_surface`` /
    ``origin_surface``) is preserved by the pipeline, so an automated-scan case
    stays in the Automated Scans tab. Returns a NEUTRAL 400 if no events remain
    (the cluster aged out of the configured window).
    """
    case = await state.cases.get(case_id)
    if not case:
        raise HTTPException(status_code=404, detail="Case not found")
    query_source = state.active_source_for_id(case.source_id)
    cluster = await _cluster_for_case(
        state, case, query_source=query_source
    )
    if cluster is None:
        raise HTTPException(
            status_code=400,
            detail=(
                f"No events remain for {case.entity.type.value} {case.entity.value} "
                f"in the last {state.prefs.investigate_lookback}; the activity may have "
                "aged out of the retained log window."
            ),
        )
    # force=True so an already-investigated OPEN case is genuinely re-investigated.
    updated = await state.pipeline.investigate_cluster(
        cluster, case.source_surface, state.execution_prefs,
        force=True, query_source=query_source,
    )
    return _case_view(updated, state)


class ReinvestigateRequest(BaseModel):
    """Re-run the investigation on an existing case. Optional ``model`` overrides
    the investigation-role models (router/investigator/formatter) for THIS run via a
    prefs copy (the per-call model-override technique) — no gateway plumbing change."""

    model: str | None = None
    analyst: str = "analyst"


@router.post("/cases/{case_id}/reinvestigate")
async def case_reinvestigate(
    case_id: str,
    body: ReinvestigateRequest | None = None,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("cases", "reinvestigate")),
) -> dict[str, Any]:
    """Manually re-run the SHARED investigation pipeline on a stored case (force).

    Loads the case (404 if missing), reconstructs the cluster from the case's stored
    fields (member event ids → exact id re-query, else a config-windowed entity
    re-query — via the same robust ``_cluster_for_case`` helper the legacy
    ``/investigate`` route uses), then calls ``investigate_cluster(..., force=True)``
    so it re-runs even on an already-verdicted case. An optional ``{"model": "<id>"}``
    body overrides the investigation-role models for this run only via a prefs copy
    (still through the one gateway, #6). The case's ORIGINAL provenance
    (``source_surface``) is preserved by the pipeline. The deterministic
    close/escalate decision in the Case Manager is untouched (#3). Returns the
    updated Case. 400 (NEUTRAL) if no events remain to rebuild the cluster."""
    body = body or ReinvestigateRequest()
    case = await state.cases.get(case_id)
    if not case:
        raise HTTPException(status_code=404, detail="Case not found")
    # Rebuild the cluster from live logs; if the events aged out, fall back to a
    # minimal reconstruction from the case's STORED evidence so the re-investigation
    # runs over what we retained rather than dead-ending (#3 untouched).
    query_source = state.active_source_for_id(case.source_id)
    cluster = await _cluster_for_case(
        state, case, allow_stored_reconstruction=True, query_source=query_source
    )
    if cluster is None:
        raise HTTPException(
            status_code=400,
            detail="This case has no stored evidence to reinvestigate.",
        )
    # Per-call model override (additive): swap the investigation-role models for this
    # run only. Unchanged when body.model is None.
    prefs_eff = _override_models(
        state.execution_prefs, body.model, ("router", "investigator", "formatter")
    )
    # Audit the manual reinvestigation BEFORE the run so the trigger is recorded even
    # if the pipeline later fails-to-human (the pipeline never raises).
    await state.audit.record(
        action_type=ActionType.DECISION, surface=case.source_surface.value,
        actor="reinvestigate", case_id=case_id,
        result_summary=(
            f"manual reinvestigation requested by {body.analyst or 'analyst'}"
            + (f"; model override={body.model}" if body.model else "")
        ),
    )
    # force=True so an already-verdicted case is genuinely re-investigated in place;
    # the pipeline preserves the original source_surface/origin_surface.
    updated = await state.pipeline.investigate_cluster(
        cluster, case.source_surface, prefs_eff, force=True, query_source=query_source
    )
    return _case_view(updated, state)


@router.post("/cases/{case_id}/run-playbook", deprecated=True, status_code=410)
async def case_run_playbook(
    case_id: str,
    _=Depends(require_permission("runbooks", "run")),
) -> Any:
    """Retired (Round 14 SPEC §4.10.16): ``410 runbooks_moved``. Start a runbook on a
    case with ``POST /api/cases/{case_id}/runbooks``; re-investigate with ``POST
    /api/cases/{case_id}/reinvestigate``."""
    del case_id
    return _runbooks_moved()


@router.get("/cases/{case_id}/threat-context")
async def case_threat_context(
    case_id: str,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("cases", "read")),
) -> dict[str, Any]:
    """The assembled, read-only THREAT-CONTEXT panel for a case (F11).

    Parallel + FAIL-OPEN: IOC reputation, MITRE technique metadata, related resolved
    cases, asset context + evidence. Advisory only — it never touches the
    deterministic decision (#3). All free-text it carries is case/log-derived and is
    rendered as plain text / code blocks by the UI (#9). 404 if the case is unknown."""
    from ..engine import threat_context as tc

    case = await state.cases.get(case_id)
    if not case:
        raise HTTPException(status_code=404, detail="Case not found")
    prefs = state.execution_prefs
    enrich = EnrichTool(state.secrets, prefs, state.cache)
    panel = await tc.assemble(
        case, prefs, enrich=enrich, rag=state.rag_service, cases=state.cases
    )
    return panel.model_dump(mode="json")


class ThreatContextImportBody(BaseModel):
    """Ingest an operator-supplied threat-intelligence document into RAG (F11)."""

    title: str
    content: str
    tags: list[str] = Field(default_factory=list)


@router.post("/threat-context/import")
async def threat_context_import(
    body: ThreatContextImportBody,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("rag", "manage")),
) -> dict[str, Any]:
    """Import a threat-intel document into the RAG corpus as ``source="threat_context"``
    (F11). It becomes retrievable knowledge and is injected as a TRUSTED FENCED block
    in investigations (#9). Gated by ``rag:manage``. Returns the import summary
    (``{document_id, title, source, chunk_count}``)."""
    title = (body.title or "").strip()
    content = (body.content or "").strip()
    if not title or not content:
        raise HTTPException(status_code=400, detail="title and content are required")
    result = await state.rag_service.import_threat_context(title, content, tags=body.tags)
    await state.audit.record(
        action_type=ActionType.CONTEXT, surface="rag", actor="analyst",
        result_summary=(
            f"imported threat_context document {result.get('document_id')} "
            f"({result.get('chunk_count')} chunk(s))"
        ),
    )
    return result


@router.get("/cases/{case_id}/trace")
async def case_trace(case_id: str, state: AppState = Depends(get_state)) -> dict[str, Any]:
    """Ordered agent-pipeline trace for a case (C3-3).

    Projects the already-recorded ``tlsoc-agent-audit`` rows (router → investigator
    → tool calls → verdict → formatter → case-manager decision) into a timeline.
    Read-only on the management-scoped audit index. NEVER 404s — an unknown or
    not-yet-investigated case simply returns empty ``steps``. ``prompt_excerpt`` is
    omitted when ``prefs.trace.include_prompts`` is false."""
    rows = await state.audit.records_for_case(case_id)
    include_prompts = state.prefs.trace.include_prompts
    steps = [_trace_step(row, include_prompts) for row in rows]
    return {
        "case_id": case_id,
        "steps": [s.model_dump(mode="json") for s in steps],
        "total": len(steps),
    }


@router.get("/cases/{case_id}/rationale")
async def case_rationale(case_id: str, state: AppState = Depends(get_state)) -> dict[str, Any]:
    """Case EXPLAINABILITY: a clean, human-readable "why" object assembled from the
    case + its audit records — WITHOUT calling the LLM.

    Surfaces exactly how a case reached its verdict: the persona/playbook chosen, the
    operator MEMORY facts consulted, the RAG knowledge retrieved (source + snippet),
    the IP enrichment/reputation, the read-only tools/queries the agent ran, the
    investigator's reasoning excerpt, the deterministic close/escalate rationale, the
    MITRE techniques, and the evidence. Every piece is parsed DEFENSIVELY from the
    audit rows this run writes (CONTEXT/TOOL_CALL/VERDICT) + the case fields — a
    missing piece degrades to an empty value, never an error. NEVER 404s."""
    case = await state.cases.get(case_id)
    rows = await state.audit.records_for_case(case_id)
    return _build_rationale(case_id, case, rows)


@router.get("/cases/{case_id}/forwarding")
async def case_forwarding(
    case_id: str,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("cases", "read")),
) -> dict[str, Any]:
    """Explain, READ-ONLY, WHY this case's cluster did/didn't auto-forward to the LLM
    investigator (Round 4 Wave 4).

    Rebuilds the case's cluster from its stored member events (the same read-only
    reconstruction the re-investigate path uses) and asks
    ``engine.forwarding.explain_forwarding`` which deterministic auto-forward GATE
    decided the outcome, returning a plain-English ``sentence`` + the deciding
    ``gate``. Pure narrator: it NEVER calls ``decide()`` (#3), makes NO LLM call (#6),
    and never mutates the cluster signature (#4) — it only describes the gate the
    ingest pipeline walks BEFORE any verdict exists."""
    from ..engine.forwarding import explain_forwarding

    case = await state.cases.get(case_id)
    if not case:
        raise HTTPException(status_code=404, detail="Case not found")
    cluster = await _cluster_for_case(
        state, case, query_source=state.active_source_for_id(case.source_id)
    )
    if cluster is None:
        # No member events retrievable (e.g. purged logs) — return an honest,
        # non-erroring "unknown" gate rather than fabricating a decision.
        return {
            "case_id": case_id,
            "gate": "unknown",
            "forwarded": False,
            "dropped": False,
            "sentence": "The originating events for this case are no longer retrievable, "
                        "so the forwarding decision cannot be reconstructed.",
            "source_id": case.source_id,
            "is_alert": False,
            "notes": [],
        }
    explanation = explain_forwarding(cluster, state.prefs)
    return {"case_id": case_id, **explanation.to_dict()}


# --------------------------------------------------------------------------- #
# Automated scans (Surface 3)
# --------------------------------------------------------------------------- #
@router.get("/scans")
async def scans(limit: int = 50, state: AppState = Depends(get_state)) -> dict[str, Any]:
    cases, total = await state.cases.list_scans(limit=min(limit, 200))
    return {"cases": [c.model_dump(mode="json") for c in cases], "total": total}


@router.get("/scans/notifications")
async def scan_notifications(
    since: str = "now-24h", state: AppState = Depends(get_state)
) -> dict[str, Any]:
    since_iso = _millis_to_iso(relative_to_millis(since))
    new_count = await state.cases.count_new_scans(since_iso)
    return {"new_count": new_count, "since": since_iso, "now": iso_now()}


# --------------------------------------------------------------------------- #
# Standup (Surface 4)
# --------------------------------------------------------------------------- #
@router.get("/standup")
async def standup(
    window_hours: int | None = None, state: AppState = Depends(get_state)
) -> dict[str, Any]:
    """Daily standup summary. ALWAYS returns HTTP 200 with a renderable payload:
    a clear ``{enabled: false}`` shape when disabled, the full happy-path result
    when data is present, or a graceful ``degraded: true`` + ``error`` + a short
    summary note when the aggregation/summary step is unavailable (never a 500)."""
    prefs = state.execution_prefs
    if not prefs.standup.enabled:
        return {
            "enabled": False,
            "summary": "Standup is disabled in settings.",
            "aggregate": {},
            "cases": {},
            "window_hours": prefs.standup.window_hours,
            "degraded": False,
        }
    try:
        result = await state.standup_service.generate(prefs, window_hours=window_hours)
    except Exception as exc:  # noqa: BLE001 — belt-and-braces: the page must never 500
        logger.warning("Standup route caught an unexpected error (%s); degrading", exc)
        result = {
            "summary": "Standup is unavailable right now (limited data).",
            "aggregate": {},
            "cases": {},
            "window_hours": window_hours or prefs.standup.window_hours,
            "cost": 0.0,
            "degraded": True,
            "error": str(exc),
        }
    result["enabled"] = True
    result.setdefault("degraded", False)
    return result


# --------------------------------------------------------------------------- #
# Cost / usage (in-plugin panel)
# --------------------------------------------------------------------------- #
@router.get("/usage/summary")
async def usage_summary(
    window_hours: int = 24, case_id: str | None = None, state: AppState = Depends(get_state)
) -> dict[str, Any]:
    return await state.usage_store.summary(window_hours=window_hours, case_id=case_id)


# --------------------------------------------------------------------------- #
# Manual poll trigger (demo / ops)
# --------------------------------------------------------------------------- #
@router.post("/poll")
async def poll_now(
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("sources", "manage")),
) -> dict[str, Any]:
    # While demo is engaged, a manual poll runs a DEMO simulation tick (writing to the
    # demo store) instead of advancing the REAL durable cursor (#4). The demo tick
    # generates a deterministic benign batch + possibly a storyline through the demo
    # pipeline ($0 mock LLM, sandboxed policy). Real cursor stays untouched.
    if state.demo_active:
        # ``sources:manage`` authorizes a real manual poll. Demo mutation has its own
        # narrower grant, so a custom role cannot bypass ``demo:manage`` through this
        # legacy operational endpoint.
        await require_permission("demo", "manage")(request)
        return await state.demo_tick()
    return await state.poller.poll_once(state.prefs)


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def _override_models(prefs: Preferences, model: str | None, roles: tuple[str, ...]) -> Preferences:
    """Return a prefs COPY with the given per-role model fields overridden to
    ``model`` for a single call (the per-call model-override technique).

    Each overridden role keeps its temperature/max_tokens but takes the new model
    id + an inferred provider (so the gateway routes it to the right backend). When
    ``model`` is falsy the original prefs are returned unchanged. NO new gateway
    plumbing — every call still flows through the one gateway (#6)."""
    mid = (model or "").strip()
    if not mid:
        return prefs
    from ..llm.pricing import provider_for

    provider = provider_for(mid)
    if provider not in ("anthropic", "openai", "mock"):
        provider = "openai"  # fresh-install default for an unrecognised override id
    updates: dict[str, Any] = {}
    for role in roles:
        field = f"{role}_model"
        base = getattr(prefs, field, None)
        if base is None:
            continue
        updates[field] = base.model_copy(update={"model": mid, "provider": provider})
    if not updates:
        return prefs
    return prefs.model_copy(update=updates)


def _deep_update(dst: dict[str, Any], src: dict[str, Any]) -> dict[str, Any]:
    for key, value in src.items():
        if isinstance(value, dict) and isinstance(dst.get(key), dict):
            dst[key] = _deep_update(dst[key], value)
        else:
            dst[key] = value
    return dst


def _millis_to_iso(millis: int) -> str:
    from datetime import datetime, timezone

    return datetime.fromtimestamp(millis / 1000.0, tz=timezone.utc).isoformat()


# The auto-widen ladder and the entity-query helpers (``_WIDEN_LADDER``,
# ``_entity_field``, ``_scoped_entity_body``, ``_widen_windows``) live in
# ``engine/case_cluster.py`` (chat revamp SPEC §5.3) and are re-exported at the top
# of this module under their historical names.
async def _entity_events_widening(
    state: AppState,
    entity_type: EntityType,
    value: str,
    start_window: str,
    *,
    query_source=None,
) -> tuple[list[RawEvent], str]:
    """Route-compat wrapper: :func:`app.engine.case_cluster.entity_events_widening`
    over ``state.es`` and the active stack's ``state.execution_prefs``."""
    return await entity_events_widening(
        entity_type, value, start_window,
        es=getattr(state, "es", None),
        prefs=state.execution_prefs,
        query_source=query_source,
    )


async def _cluster_for_request(
    state: AppState, req: InvestigateRequest, *, query_source=None
) -> tuple[Cluster | None, str]:
    """Resolve an InvestigateRequest to a Cluster (with a synthesized manual
    TriggerReason). Returns (cluster_or_None, widest_window_tried)."""
    prefs = state.execution_prefs
    start_window = req.lookback or prefs.investigate_lookback

    if req.event_ids:
        if query_source is not None:
            result = await query_source.fetch_by_ids(
                prefs, req.event_ids, size=len(req.event_ids)
            )
            events = result.events
        else:
            resp = await state.es.search_logs(
                prefs.data_view_pattern, ids_query(req.event_ids, size=len(req.event_ids))
            )
            hits = resp.get("hits", {}).get("hits", [])
            events = [RawEvent.from_hit(h, prefs) for h in hits]
        if not events:
            return None, start_window
        entity_type = req.group_by
        value = events[0].entity_value(entity_type)
        if not value:
            return None, start_window
        members = [e for e in events if e.entity_value(entity_type) == value]
        if not members:
            return None, start_window
        window = start_window
    elif req.entity:
        entity_type, value = req.entity.type, req.entity.value
        events, window = await _entity_events_widening(
            state, entity_type, value, start_window, query_source=query_source
        )
        if not events:
            return None, window
        members = [e for e in events if e.entity_value(entity_type) == value]
        if not members:
            return None, window
    else:
        return None, start_window

    cluster = cluster_from_events(entity_type, value, members)
    cluster.trigger_reason = _manual_trigger_reason(cluster, window)
    return cluster, window


async def _cluster_for_case(
    state: AppState,
    case,
    *,
    allow_stored_reconstruction: bool = False,
    query_source=None,
) -> Cluster | None:
    """Route-compat wrapper: :func:`app.engine.case_cluster.cluster_for_case` with
    ``state.es``, ``state.log_source`` and ``state.execution_prefs`` as its explicit
    dependencies (moved there by chat revamp SPEC §5.3). ``query_source`` is still
    resolved by the caller (``state.active_source_for_id(case.source_id)``)."""
    return await cluster_for_case(
        case,
        es=getattr(state, "es", None),
        log_source=getattr(state, "log_source", None),
        prefs=state.execution_prefs,
        allow_stored_reconstruction=allow_stored_reconstruction,
        query_source=query_source,
    )


# ``_reconstruct_cluster_from_case`` and ``_manual_trigger_reason`` live in
# ``engine/case_cluster.py`` and are re-exported at the top of this module.


def _no_events_detail(req: InvestigateRequest, widest: str) -> str:
    """NEUTRAL, specific 400 detail for an empty manual investigation."""
    if req.entity:
        return (
            f"No events found for {req.entity.type.value} {req.entity.value} "
            f"in the last {widest}"
        )
    if req.event_ids:
        return "No events found for the selected document ids"
    return "Could not resolve events for this request"


# ``_audit_get`` and ``_build_rationale`` live in ``engine/case_rationale.py`` (chat
# revamp SPEC §5.3) and are re-exported at the top of this module.


def _trace_step(row: dict[str, Any], include_prompts: bool) -> TraceStep:
    """Project a raw audit row into a TraceStep (C3-3). Honors the include_prompts
    toggle by dropping the (untrusted) prompt excerpt when disabled."""
    return TraceStep(
        ts=str(row.get("ts", "")),
        app_version=row.get("app_version"),
        build_sha=row.get("build_sha"),
        actor=str(row.get("actor", "")),
        action_type=row.get("action_type"),
        model=row.get("model"),
        query_text=row.get("query_text"),
        tool_name=row.get("tool_name"),
        tool_input=row.get("tool_input"),
        tool_output_summary=row.get("tool_output_summary"),
        result_summary=row.get("result_summary"),
        prompt_excerpt=(row.get("prompt_excerpt") if include_prompts else None),
    )
