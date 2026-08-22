"""All backend HTTP routes (the plugin contract)."""

from __future__ import annotations

import hashlib
import json
import logging
import os
from collections.abc import Awaitable, Callable
from typing import Any, Literal
from urllib.parse import quote_plus

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from .. import __version__
from ..build_identity import build_stamp
from ..config import (
    Preferences,
    SourceInstance,
    SuppressionRule,
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
from ..engine.correlation import cluster_from_events
from ..engine.metrics import compute_metrics, feedback_stats
from ..engine.priority import advisory_bands
from ..es.querybuilder import entity_query, ids_query, scope_filters, scope_must_not
from ..llm.pricing import (
    model_capabilities,
    model_catalog,
    model_supports_capability,
    models_by_provider,
)
from ..models import (
    Case,
    CaseComment,
    ChatConversationRenameRequest,
    ChatRequest,
    ChatResponse,
    ChatTurn,
    Cluster,
    Entity,
    FeedbackEntry,
    InvestigateRequest,
    Proposal,
    RawEvent,
    StatusHistoryEntry,
    TraceStep,
    TriggerReason,
    validate_avatar,
)
from ..playbooks.registry import (
    MAX_PLAYBOOK_BYTES,
    PlaybookConflictError,
    PlaybookManagementError,
    PlaybookNotFoundError,
    PlaybookProtectedError,
)
from ..state import AppState
from ..stores.chat_conversations import (
    ChatConversationMissing,
    ChatHistoryUnavailable,
    ChatIdempotencyConflict,
    ChatRequestCapacityBusy,
    ChatRequestInProgress,
)
from ..stores.proposals import (
    BULK_DECISION_LIMIT,
    MAX_DECISION_REASON_CHARS,
    evidence_summary,
    proposal_is_expired,
    sanitize_decision_reason,
)
from ..tools.enrich import EnrichTool
from ..utils import (
    iso_now,
    new_id,
    now_utc,
    parse_es_timestamp,
    relative_to_millis,
    to_millis,
)
from .deps import (
    _audit_session,
    _bearer,
    current_user,
    current_username,
    get_state,
    has_permission,
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
# 'cases:{case_id}' (exact-match topic) — allowed via the prefix below.
_REALTIME_TOPICS = frozenset({"notifications", "inbox", "jobs", "cases", "agent"})


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
async def setup_status(state: AppState = Depends(get_state)) -> dict[str, Any]:
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


@router.post("/setup/secrets")
async def setup_secrets(
    body: SecretsUpdate,
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
    await state.apply_secrets(updates)
    return {"ok": True, "configured": state.secrets.configured_status()}


@router.post("/setup/complete")
async def setup_complete(
    state: AppState = Depends(get_state),
    _=Depends(require_permission("settings", "manage")),
) -> dict[str, Any]:
    prefs = await state.mutate_prefs(
        lambda current: current.model_copy(update={"setup_complete": True})
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
    rows = [s.model_dump(mode="json") for s in state.prefs.sources]
    return {"sources": rows}


@router.post("/sources")
async def upsert_source(
    body: SourceUpsert,
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
            **({"created_at": existing.created_at} if existing else {}),
        )
        # Wave 6: keep ``config['data_view_pattern']`` synced to the comma-join of the
        # non-ignore feed patterns, so the legacy single-pattern fallback + any reader of
        # ``data_view_pattern`` see the live surface MINUS muted ignore feeds. No-op when
        # no feeds are configured (the operator-set ``data_view_pattern`` is left intact).
        live_dv = instance.live_data_view()
        if live_dv:
            instance.config["data_view_pattern"] = live_dv
        # Upsert by id; a new primary unsets any previous primary.
        others = [s for s in p.sources if s.id != body.id]
        if instance.is_primary:
            for s in others:
                s.is_primary = False
        return p.model_copy(update={"sources": others + [instance]})

    prefs = await state.mutate_prefs(_apply)
    state.rebuild_log_source()
    await state.reconcile_receivers()
    return {"ok": True, "sources": [s.model_dump(mode="json") for s in prefs.sources]}


@router.delete("/sources/{source_id}")
async def delete_source(
    source_id: str,
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

    prefs = await state.mutate_prefs(_apply)
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
    state: AppState = Depends(get_state),
    _=Depends(require_permission("sources", "manage")),
) -> dict[str, Any]:
    """Set/clear a source's secret fields (e.g. a webhook token, a Splunk key).

    Values go to the secret tier (in memory), NEVER to the persisted config; only
    the configured field NAMES are recorded on the SourceInstance (#10)."""
    src = next((s for s in state.prefs.sources if s.id == source_id), None)
    if src is None:
        raise HTTPException(status_code=404, detail="Source not found")
    for field, value in body.items():
        state.secrets.set_source_secret(source_id, field, value)
    configured = sorted(state.secrets.source_secrets(source_id).keys())

    # Persist only the configured secret NAMES onto the source, atomically against the
    # freshest prefs (mutate_prefs) so a concurrent full-doc writer can't drop the update.
    def _apply(p: Preferences) -> Preferences:
        cur = next((s for s in p.sources if s.id == source_id), None)
        if cur is None:  # removed concurrently — nothing to stamp the names onto
            return p
        updated = cur.model_copy(update={"configured_secrets": configured})
        others = [s for s in p.sources if s.id != source_id]
        return p.model_copy(update={"sources": others + [updated]})

    await state.mutate_prefs(_apply)
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

    Returns ``{suggested_mappings, fields}`` — the suggested field-name overrides
    (``source_ip_field``/``user_field``/``host_field``/``message_field``/
    ``severity_field``/``rule_field``/...) and the flattened path inventory the UI
    renders. Pure heuristic (no LLM/network). The sample is SANITIZED (flattened to
    paths only) and is NEVER persisted to the config doc / secret tier (#9)."""
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
def _log_message(src: dict[str, Any]) -> str:
    from ..utils import dotted_get
    for f in (
        "message", "description", "full_log", "event.original", "log.message",
        "event.action", "rule.description",
    ):
        v = dotted_get(src, f)
        if v:
            return str(v) if not isinstance(v, list) else str(v[0])
    return ""


def _log_row(ev) -> dict[str, Any]:
    """Project a RawEvent → the browse-logs row contract. _raw is the full log
    document (log data, never secrets)."""
    import datetime as _dt
    ts_iso = ""
    if getattr(ev, "timestamp_millis", 0):
        ts_iso = _dt.datetime.fromtimestamp(ev.timestamp_millis / 1000, tz=_dt.timezone.utc).isoformat()
    return {
        "id": ev.id,
        "ts": ts_iso,
        "source_ip": ev.ip,
        "user": ev.user,
        "host": ev.host,
        "rule": ev.rule or ev.rule_name,
        "severity": ev.severity,
        "message": _log_message(ev.source or {}),
        "_raw": ev.source or {},
    }


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
    never returned (rows are log data only)."""
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
                "mode": "buffer",
                "count": len(rows),
                "total": result.total,
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
        return {"source_id": source_id, "mode": "buffer", "count": len(rows), "logs": rows}

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
                    "total": result.total, "logs": rows,
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
def _source_can_browse(reg, src) -> bool:
    """True when a source advertises the ``browse`` capability (registry augments every
    push receiver with it; pull manifests declare it explicitly). Defensive — a missing
    manifest / odd capabilities list is treated as NOT browsable rather than raising."""
    try:
        manifest = reg.manifest(src.source_type)
    except Exception:  # noqa: BLE001 — one bad manifest never breaks the scan
        return False
    return bool(manifest) and "browse" in (manifest.capabilities or [])


@router.get("/logs")
async def unified_logs(
    limit: int = 100,
    query: str | None = None,
    from_: str | None = Query(default=None, alias="from"),
    to: str | None = None,
    per_source_timeout: float = 8.0,
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
    a per-source error entry and NEVER blocks the rest (partial success)."""
    import asyncio

    limit = max(1, min(int(limit or 100), 200))  # hard cap (per source AND on the merge)
    timeout = max(0.5, min(float(per_source_timeout or 8.0), 30.0))
    reg = get_registry()

    async def _read_pull(src) -> list[dict[str, Any]]:
        es_client, owned = state.es_client_for_source(src)
        try:
            from ..connectors.base import StructuredQuery
            from ..connectors.elastic import ElasticConnector
            from ..connectors.opensearch import OpenSearchConnector
            from ..connectors.wazuh import WazuhConnector
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
            result = await conn.search(state.prefs, sq)
            return [_log_row(ev) for ev in result.events]
        finally:
            if owned:
                try:
                    await es_client.close()
                except Exception:  # noqa: BLE001
                    pass

    async def _read_push(src) -> list[dict[str, Any]]:
        return [_log_row(ev)
                for ev in state.ingest_service.recent_events_for_source(src.id, limit)]

    async def _read_demo(src) -> list[dict[str, Any]]:
        conn = state.demo_source_connector(src.id)
        if conn is None:
            return []
        from ..connectors.base import StructuredQuery

        result = await conn.search(
            state.prefs,
            StructuredQuery(
                contains=(query or None), time_from=from_, time_to=to,
                size=limit, sort_desc=True,
            ),
        )
        return [_log_row(ev) for ev in result.events]

    # Select the enabled + browse-capable sources and pair each read coroutine with its
    # source (for provenance + error attribution). Unsupported sources are skipped.
    targets: list[tuple[Any, Any]] = []
    if state.demo_active:
        from types import SimpleNamespace

        for row in state.demo_sources_overlay():
            sid = str(row.get("id"))
            if not sid:
                continue
            src = SimpleNamespace(id=sid, display_name=row.get("display_name") or sid)
            targets.append((src, _read_demo(src)))
    else:
        for src in state.prefs.sources:
            if not src.enabled or not _source_can_browse(reg, src):
                continue
            cls = reg.get(src.source_type)
            if cls is None:
                continue
            if reg.is_receiver(src.source_type):
                targets.append((src, _read_push(src)))
            elif reg.is_pull(src.source_type):
                targets.append((src, _read_pull(src)))

    async def _guarded(coro):
        return await asyncio.wait_for(coro, timeout=timeout)

    results = await asyncio.gather(
        *[_guarded(coro) for _, coro in targets], return_exceptions=True
    )

    merged: list[dict[str, Any]] = []
    source_status: list[dict[str, Any]] = []
    for (src, _coro), outcome in zip(targets, results):
        if isinstance(outcome, Exception):
            source_status.append({
                "source_id": src.id, "source_name": src.display_name or src.id,
                "ok": False,
                "error": ("timeout" if isinstance(outcome, asyncio.TimeoutError)
                          else str(outcome)),
                "count": 0,
            })
            continue
        rows = outcome or []
        for row in rows:
            # MANDATORY provenance — overwrite (never trust a per-source row to self-label).
            row["source_id"] = src.id
            row["source_name"] = src.display_name or src.id
        merged.extend(rows)
        source_status.append({
            "source_id": src.id, "source_name": src.display_name or src.id,
            "ok": True, "count": len(rows),
        })

    # Merge newest-first by ts (ISO strings sort lexicographically for UTC; empty ts
    # sorts last). Then hard-cap the merged view.
    merged.sort(key=lambda r: (r.get("ts") or ""), reverse=True)
    merged = merged[:limit]
    return {
        "logs": merged,
        "count": len(merged),
        "sources": source_status,
        "partial": any(not s["ok"] for s in source_status),
    }


async def _cursor_millis(state: AppState, src) -> int:
    """Newest processed timestamp across a source's feeds (0 = never polled).

    Mirrors the poller's durable cursor key ``f'{source.id}:{feed.id}'`` (falling back
    to the legacy single-source cursor). Read-only; a store hiccup fails soft to 0 rather
    than breaking the whole health view."""
    best = 0
    try:
        feeds = src.feeds()
        keys: list[str] = []
        if feeds:
            keys = [f"{src.id}:{f.id}" for f in feeds]
        else:
            # Un-fed source: the primary uses the legacy 'primary' key; a non-primary
            # un-fed source uses a distinct 'f{id}:primary' key (see PollerManager).
            keys = ["primary" if src.is_primary else f"{src.id}:primary"]
        for key in keys:
            try:
                cur = await state.cursor_store.load_keyed(key)
            except Exception:  # noqa: BLE001
                continue
            best = max(best, int(getattr(cur, "timestamp_millis", 0) or 0))
    except Exception:  # noqa: BLE001 — health is best-effort, never raises
        return best
    return best


def _wallclock_last_event_millis(last_event_map: dict, source_id: str) -> int:
    """Epoch-millis of the last WALL-CLOCK event arrival for a source (0 when never seen).

    Reads ``state._source_last_event`` (the silence clock ``state.silent_sources`` uses,
    updated on any tick with events) so ``last_event_millis`` / ``worst_last_event_seconds``
    agree with the ``silent`` flag. Fails soft to 0 — advisory only (#3)."""
    last_ev = (last_event_map or {}).get(source_id)
    if last_ev is None:
        return 0
    try:
        return int(to_millis(last_ev))
    except Exception:  # noqa: BLE001
        return 0


async def _sources_health_rows(state: AppState) -> list[dict[str, Any]]:
    """Build the per-source health rows for the REAL configured sources (the demo overlay
    is added by the ``/sources/health`` caller). Each row carries the legacy shape PLUS the
    additive coverage-observability fields (A5.2): ``last_poll_at``/``last_poll_ok``/
    ``last_poll_error`` (from the poller's in-memory last-tick snapshot), ``events_per_min``
    (smoothed rate; pull from the poller, push from the ingest ring), ``last_event_millis``
    (a wall-clock/event watermark for the coverage rollup), and ``silent`` (the v0 flat
    silent-source flag from ``state.silent_sources``). All advisory (#3); connector error
    strings are plain text (#9); NO secrets. Never raises — every lookup fails soft."""
    reg = get_registry()
    try:
        snaps = state.poller.last_tick_by_source()
    except Exception:  # noqa: BLE001 — the snapshot is advisory; degrade to none
        snaps = {}
    try:
        silent_set = set(state.silent_sources(state.prefs))
    except Exception:  # noqa: BLE001
        silent_set = set()
    last_event_map = getattr(state, "_source_last_event", {}) or {}
    ingest_service = getattr(state, "ingest_service", None)

    out: list[dict[str, Any]] = []
    for src in state.prefs.sources:
        is_receiver = reg.is_receiver(src.source_type)
        is_pull = (not is_receiver) and reg.is_pull(src.source_type)
        row: dict[str, Any] = {
            "source_id": src.id,
            "source_name": src.display_name or src.id,
            "source_type": src.source_type.value,
            "enabled": src.enabled,
            "is_primary": src.is_primary,
            "ingest_mode": src.ingest_mode.value,
            "kind": "push" if is_receiver else ("pull" if is_pull else "unknown"),
            "can_browse": _source_can_browse(reg, src),
            "buffer_depth": 0,
            "last_poll_millis": 0,
            # --- Coverage observability (A5.2), additive + advisory ---
            "last_poll_at": None,
            "last_poll_ok": None,
            "last_poll_error": None,
            "last_event_millis": 0,
            "events_per_min": 0.0,
            "silent": bool(src.id in silent_set),
        }
        if is_receiver:
            if ingest_service is not None:
                row["buffer_depth"] = len(
                    ingest_service.recent_events_for_source(src.id, 500)
                )
                try:
                    row["events_per_min"] = float(
                        ingest_service.events_per_min_for_source(src.id) or 0.0
                    )
                except Exception:  # noqa: BLE001
                    row["events_per_min"] = 0.0
            # PUSH last-event is a wall-clock (the arrival clock the silence check uses).
            row["last_event_millis"] = _wallclock_last_event_millis(last_event_map, src.id)
        elif is_pull and src.enabled:
            lp = await _cursor_millis(state, src)
            row["last_poll_millis"] = lp
            # last_event = the more-recent of the cursor's event watermark and the
            # wall-clock silence clock (state._source_last_event), so it agrees with the
            # ``silent`` flag + drives ``worst_last_event_seconds`` even before the cursor
            # advances (e.g. a source that reported once then went quiet).
            row["last_event_millis"] = max(lp, _wallclock_last_event_millis(last_event_map, src.id))
            snap = snaps.get(src.id)
            if isinstance(snap, dict):
                row["last_poll_at"] = snap.get("ts")
                row["last_poll_ok"] = snap.get("ok")
                # Plain text — a connector error is source-controlled data (#9).
                row["last_poll_error"] = snap.get("error")
                try:
                    row["events_per_min"] = float(snap.get("events_per_min", 0.0) or 0.0)
                except (TypeError, ValueError):
                    row["events_per_min"] = 0.0
        out.append(row)
    return out


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
    or over the isolated native demo sources while Demo Mode is active. ``alerts_triaged_24h`` is
    the count of cases opened in the last 24h computed with the SAME window filter the
    ``/metrics/noise-reduction`` endpoint uses, so the two agree. Never raises — every
    sub-lookup degrades to a safe zero (#3/#4/#6/#9 untouched)."""
    # Demo reads are intentionally scoped to the throwaway demo stack, just like cases,
    # metrics, usage, and RAG. Including the four real simulator rows avoids the previous
    # misleading 0/0 coverage tile without leaking tenant-source health into a demo.
    rows = (
        state.demo_source_health_overlay()
        if state.demo_active
        else await _sources_health_rows(state)
    )
    now_ms = to_millis(now_utc())
    enabled_rows = [r for r in rows if r.get("enabled")]
    sources_silent = sum(1 for r in enabled_rows if r.get("silent"))
    events_per_min = round(
        sum(float(r.get("events_per_min") or 0.0) for r in enabled_rows), 2
    )
    worst = 0
    for r in enabled_rows:
        lev = int(r.get("last_event_millis") or 0)
        if lev > 0:
            worst = max(worst, (now_ms - lev) // 1000)

    # Cases opened in the last 24h — the SAME newest-N page + 24h window the noise-reduction
    # funnel's ``cases`` stage uses, so ``alerts_triaged_24h`` is cross-consistent with it.
    alerts_triaged = 0
    try:
        cases, _total = await state.cases.list(limit=5000)
        from ..engine.metrics import _window_filter

        alerts_triaged = len(_window_filter(list(cases), window_hours=24))
    except Exception:  # noqa: BLE001 — a store hiccup degrades to 0, never a 500
        alerts_triaged = 0

    payload = {
        "sources_total": len(rows),
        "sources_enabled": len(enabled_rows),
        "sources_silent": int(sources_silent),
        "events_per_min": events_per_min,
        "alerts_triaged_24h": int(alerts_triaged),
        "worst_last_event_seconds": int(max(0, worst)),
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
        if not model_supports_capability(embedding_id, "embedding"):
            raise HTTPException(
                status_code=422,
                detail=(
                    f"Invalid settings: model {embedding_id!r} is not declared "
                    "embedding-capable"
                ),
            )
    # Build the partial deep-merge from the freshest Preferences document while the
    # application-wide prefs lock is held. This prevents a settings write racing a
    # source/rule/tuner/branding writer from silently restoring a stale sibling block.
    old_prefs: Preferences | None = None

    def _apply(current: Preferences) -> Preferences:
        nonlocal old_prefs
        if (
            current.read_only_settings_mode
            and body.get("read_only_settings_mode") is not False
        ):
            raise HTTPException(status_code=403, detail="Settings are in read-only mode")
        old_prefs = current
        merged = _deep_update(current.model_dump(mode="json"), body)
        # Demo Mode is managed ONLY by the /api/demo/* endpoints — never via this path.
        merged["demo"] = current.demo.model_dump(mode="json")
        try:
            return Preferences.model_validate(merged)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=422, detail=f"Invalid settings: {exc}") from exc

    prefs = await state.mutate_prefs(_apply)
    assert old_prefs is not None
    # P12 (#2 audit / #10 secrets): settings now carry the decision-critical auto-close
    # policy (bug-#1 repointed the flagship toggle to ``prefs.auto_close.<verdict>``, the
    # field ``decide()`` reads), so an operator changing which cases auto-close must leave
    # an append-only who/when trail — like rule edits + reset already do. Record only the
    # CHANGED top-level keys (never their values → never a secret, #10). Best-effort: an
    # audit glitch must never fail the settings save (mirrors terminology_put).
    changed = sorted(str(k) for k in body.keys()) if isinstance(body, dict) else []
    try:
        await state.control_audit.record(
            action_type=ActionType.STATUS, surface="settings",
            actor=current_username(request) or "",
            result_summary=("updated settings: " + ", ".join(changed))[:500]
            if changed else "updated settings",
        )
    except Exception:  # noqa: BLE001 — audit is best-effort; never break the save
        pass
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
    """Stable identity over caller-controlled inputs (never over generated ids)."""
    payload = body.model_dump(
        mode="json", exclude={"idempotency_key", "persist_conversation"}
    )
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _replayed_chat_response(reservation) -> ChatResponse:
    conversation = reservation.conversation
    assistant = reservation.assistant_message
    if assistant is None:
        raise _chat_history_http(
            ChatHistoryUnavailable("The completed chat response could not be restored.")
        )
    payload = dict(assistant.response or {})
    payload.update({
        "answer": assistant.content,
        "conversation_id": reservation.conversation_id,
        "conversation_title": reservation.conversation_title
        or (conversation.title if conversation else "Conversation"),
        "idempotency_key": reservation.idempotency_key,
        "effective_model": assistant.model or (conversation.model if conversation else None),
        "effective_source_id": assistant.source_id
        or (conversation.source_id if conversation else None),
        "effective_source_name": assistant.source_name
        or (conversation.source_name if conversation else None),
        "truncated": bool(payload.get("truncated")),
    })
    try:
        return ChatResponse.model_validate(payload)
    except Exception as exc:  # noqa: BLE001 -- corrupt durable receipt is a store failure
        raise _chat_history_http(
            ChatHistoryUnavailable("The completed chat response is invalid.")
        ) from exc


@router.get("/chat/conversations")
async def list_chat_conversations(
    request: Request,
    state: AppState = Depends(get_state),
    limit: int = Query(default=30, ge=1, le=50),
    offset: int = Query(default=0, ge=0),
    _=Depends(require_permission("cases", "read")),
) -> dict[str, Any]:
    """Newest-first Workspace conversation summaries owned by this principal.

    Auth-disabled deployments use the same isolated ``default`` profile as user
    preferences. Case-scoped collaboration chat is intentionally not listed here.
    """
    try:
        page = await state.chat_conversations.list_page(
            current_username(request), limit=limit, offset=offset,
        )
    except ChatHistoryUnavailable as exc:
        raise _chat_history_http(exc) from exc
    return {
        "conversations": [item.model_dump(mode="json") for item in page.conversations],
        # ``total`` remains the retained/paginatable count for compatibility.
        "total": page.total,
        "history_truncated": page.history_truncated,
        "total_conversation_count": page.total_conversation_count,
        "oldest_retained_at": page.oldest_retained_at,
        "limit": limit,
        "offset": offset,
    }


@router.get("/chat/conversations/{conversation_id}")
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


@router.patch("/chat/conversations/{conversation_id}")
async def rename_chat_conversation(
    conversation_id: str,
    body: ChatConversationRenameRequest,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("cases", "read")),
) -> dict[str, Any]:
    """Rename one owned conversation with bounded, single-line plain text."""
    user = current_username(request)
    try:
        conversation = await state.chat_conversations.rename(
            user, conversation_id, body.title
        )
    except ChatHistoryUnavailable as exc:
        raise _chat_history_http(exc) from exc
    if conversation is None:
        raise HTTPException(status_code=404, detail="conversation not found")
    await state.audit.record(
        action_type=ActionType.CONTEXT,
        surface="chat_history",
        actor=user,
        result_summary=f"conversation renamed: {conversation.id}"[:500],
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


@router.post("/chat")
async def chat(
    body: ChatRequest, request: Request, state: AppState = Depends(get_state),
    _=Depends(require_permission("cases", "read")),
) -> dict[str, Any]:
    # The auth dependency already verified the principal; the same helper used by
    # preferences/history defines the auth-off ``default`` partition.
    author = current_username(request)
    # Workspace history is opt-in and NEVER duplicates case-scoped turns. Context may
    # carry a case id even when the top-level field does not, so resolve the effective
    # case boundary before deciding whether this belongs in personal history.
    effective_case_id = body.case_id or (body.context.case_id if body.context else None)
    persist_workspace = bool(body.persist_conversation and not effective_case_id)
    history = body.history
    existing_conversation = None
    if persist_workspace and body.conversation_id:
        try:
            existing_conversation = await state.chat_conversations.get(
                author, body.conversation_id
            )
        except ChatHistoryUnavailable as exc:
            raise _chat_history_http(exc) from exc
        if existing_conversation is None:
            raise HTTPException(status_code=404, detail="conversation not found")
        # The durable transcript is authoritative for a resumed conversation. Ignore
        # caller-supplied history so a client cannot replace another turn sequence.
        history = [
            ChatTurn(role=item.role, content=item.content)
            for item in existing_conversation.messages
        ]

    # Per-call model override (additive): run THIS chat turn with the chat-role model
    # swapped to body.model via a prefs copy. Unchanged when body.model is None.
    # ``None`` means the CURRENT default. The UI resends a saved non-default
    # selection while resuming; omitting it is how an analyst resets the thread.
    selected_model = body.model
    prefs_eff = _override_models(state.execution_prefs, selected_model, ("chat",))
    selected_source_id = body.source_id
    request_key = body.idempotency_key or new_id("chatreq-")
    request_fingerprint = _chat_request_fingerprint(body)
    reservation = None
    source_conn = None
    owned_client = None
    effective_source_id = None
    effective_source_name = None
    try:
        if persist_workspace:
            try:
                reservation = await state.chat_conversations.reserve_exchange(
                    author,
                    idempotency_key=request_key,
                    request_fingerprint=request_fingerprint,
                    conversation_id=body.conversation_id,
                )
            except ChatHistoryUnavailable as exc:
                raise _chat_history_http(exc) from exc
            except ChatRequestInProgress as exc:
                raise _chat_conflict_http("chat_request_in_progress", str(exc)) from exc
            except ChatRequestCapacityBusy as exc:
                raise _chat_conflict_http("chat_request_capacity_busy", str(exc)) from exc
            except ChatIdempotencyConflict as exc:
                raise _chat_conflict_http("chat_idempotency_conflict", str(exc)) from exc
            except ChatConversationMissing as exc:
                raise HTTPException(status_code=404, detail="conversation not found") from exc
            if reservation.status == "completed":
                return _replayed_chat_response(reservation).model_dump(mode="json")

        # Resolve a live source only after durable replay had a chance to return.
        # A historical receipt remains replayable even if its source was later
        # disabled or removed. New executions reject an unusable explicit source.
        source_conn, owned_client, effective_source_id, effective_source_name = (
            _chat_source_connector(state, selected_source_id)
        )
        resp = await state.chat_engine.chat(
            body.message, prefs_eff, case_id=body.case_id, history=history,
            context=body.context, author=author, source=source_conn,
            can_manage_memory=await has_permission(request, "memory", "manage"),
        )
    except HTTPException:
        if persist_workspace and reservation is not None:
            try:
                await state.chat_conversations.abort_exchange(
                    author,
                    idempotency_key=request_key,
                    request_fingerprint=request_fingerprint,
                    lease_token=reservation.lease_token or "",
                )
            except Exception:  # noqa: BLE001 -- preserve the typed HTTP failure
                pass
        raise
    except Exception:
        if persist_workspace and reservation is not None:
            try:
                await state.chat_conversations.abort_exchange(
                    author,
                    idempotency_key=request_key,
                    request_fingerprint=request_fingerprint,
                    lease_token=reservation.lease_token or "",
                )
            except Exception:  # noqa: BLE001 -- never hide the original model failure
                pass
        raise
    finally:
        if owned_client is not None:
            try:
                await owned_client.close()
            except Exception:  # noqa: BLE001
                pass
    if persist_workspace:
        assert reservation is not None
        response_with_provenance = resp.model_copy(update={
            "idempotency_key": request_key,
            "effective_model": resp.effective_model,
            "effective_source_id": effective_source_id,
            "effective_source_name": effective_source_name,
        })
        try:
            completed = await state.chat_conversations.complete_exchange(
                author,
                idempotency_key=request_key,
                request_fingerprint=request_fingerprint,
                conversation_id=reservation.conversation_id,
                lease_token=reservation.lease_token or "",
                requested_existing_conversation=body.conversation_id is not None,
                user_content=body.message,
                assistant_content=resp.answer,
                response=response_with_provenance.model_dump(mode="json"),
                model=resp.effective_model,
                source_id=effective_source_id,
                source_name=effective_source_name,
            )
        except ChatHistoryUnavailable as exc:
            raise _chat_history_http(exc) from exc
        except ChatConversationMissing as exc:
            raise _chat_conflict_http(
                "chat_idempotency_conflict",
                "The conversation changed while the response was being saved.",
            ) from exc
        except ChatIdempotencyConflict as exc:
            raise _chat_conflict_http("chat_idempotency_conflict", str(exc)) from exc
        except ChatRequestInProgress as exc:
            raise _chat_conflict_http("chat_request_in_progress", str(exc)) from exc
        conversation = completed.conversation
        if conversation is None:
            raise _chat_history_http(
                ChatHistoryUnavailable("The saved conversation could not be restored.")
            )
        resp = response_with_provenance.model_copy(update={
            "conversation_id": conversation.id,
            "conversation_title": conversation.title,
            "truncated": bool(
                (completed.assistant_message.response or {}).get("truncated")
                if completed.assistant_message is not None else False
            ),
        })
    else:
        resp = resp.model_copy(update={
            "idempotency_key": body.idempotency_key,
            "effective_model": resp.effective_model,
            "effective_source_id": effective_source_id,
            "effective_source_name": effective_source_name,
        })
    return resp.model_dump(mode="json")


def _chat_source_connector(state: AppState, source_id: str | None):
    """Build the PULL connector for an explicitly-selected chat source.

    Returns connector/client plus the truthful effective id/name. ``None`` connector
    means use the engine's configured primary only when no explicit id was supplied.
    Explicit unknown, disabled, receiver-only or unbuildable sources return 422."""
    if not source_id:
        if state.demo_active:
            from ..engine.demo_sources import DEMO_SOURCE_SPECS

            spec = DEMO_SOURCE_SPECS["splunk"]
            return None, None, spec.source_id, spec.display_name
        primary = state.execution_prefs.primary_source()
        return (
            None,
            None,
            primary.id if primary is not None else None,
            (primary.display_name or primary.id) if primary is not None else "Primary source",
        )
    if state.demo_active:
        # Demo push adapters expose the same bounded search contract as a pull
        # connector, so chat source selection remains truthful for all four rows.
        connector = state.demo_source_connector(source_id)
        if connector is None:
            raise HTTPException(
                status_code=422,
                detail={
                    "code": "chat_source_unavailable",
                    "message": "The selected source is unavailable for chat.",
                },
            )
        rows = state.demo_sources_overlay()
        row = next((item for item in rows if item.get("id") == source_id), {})
        return connector, None, source_id, str(row.get("display_name") or source_id)
    src = next((s for s in state.prefs.sources if s.id == source_id and s.enabled), None)
    if src is None:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "chat_source_unavailable",
                "message": "The selected source is unknown or disabled.",
            },
        )
    reg = get_registry()
    if not reg.is_pull(src.source_type):
        raise HTTPException(
            status_code=422,
            detail={
                "code": "chat_source_unavailable",
                "message": "The selected source does not provide a query surface.",
            },
        )
    try:
        from ..connectors.elastic import ElasticConnector
        from ..connectors.opensearch import OpenSearchConnector
        from ..connectors.wazuh import WazuhConnector

        es_client, owned = state.es_client_for_source(src)
        cfg = {**(src.config or {})}
        if src.display_name:
            cfg.setdefault("display_name", src.display_name)
        if src.source_type == SourceType.OPENSEARCH:
            conn = OpenSearchConnector(es_client, config=cfg, connector_id=src.id)
        elif src.source_type == SourceType.WAZUH:
            conn = WazuhConnector(es_client, config=cfg, connector_id=src.id)
        else:
            conn = ElasticConnector(es_client, config=cfg, connector_id=src.id)
        return (
            conn,
            (es_client if owned else None),
            src.id,
            src.display_name or src.id,
        )
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=422,
            detail={
                "code": "chat_source_unavailable",
                "message": "The selected source could not be prepared for chat.",
            },
        ) from exc


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
    return case.model_dump(mode="json")


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
def _proposal_public(proposal: Proposal) -> dict[str, Any]:
    """Public projection; lease and immutable recovery identity stay internal.

    Carries the derived ``evidence`` block so a review card renders exactly the claim
    the server is willing to act on: a bulk-ratified or unverifiable basis is never
    presented as analyst-confirmed, and ``evidence.approvable`` tells the UI in advance
    that the approve button would be refused.
    """
    data = proposal.model_dump(
        mode="json", exclude={"applying_token", "decision_actor"}
    )
    data["evidence"] = evidence_summary(proposal)
    data["expired"] = proposal.status == "expired" or proposal_is_expired(proposal)
    return data


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


def _playbook_payload(state: AppState, playbook, *, content: str | None = None) -> dict[str, Any]:
    """Stable public playbook shape; never exposes the server filesystem path."""
    payload: dict[str, Any] = {
        "id": playbook.id,
        "name": playbook.name,
        "version": playbook.version,
        "description": playbook.manifest.description,
        "priority": playbook.manifest.priority,
        "match": {
            "rule_ids": list(playbook.manifest.match.rule_ids),
            "entity_types": list(playbook.manifest.match.entity_types),
            "mitre": list(playbook.manifest.match.mitre),
            "min_event_count": playbook.manifest.match.min_event_count,
            "any_tags": list(playbook.manifest.match.any_tags),
        },
        "suggested_tools": list(playbook.manifest.suggested_tools),
        "rag_queries": list(playbook.manifest.rag_queries),
        "escalate_if": playbook.manifest.escalate_if,
        "suggested_verdict_bias": playbook.manifest.suggested_verdict_bias,
        **state.playbooks.metadata(playbook),
    }
    if content is not None:
        payload["content"] = content
        payload["body"] = playbook.body
    return payload


class PlaybookCreateRequest(BaseModel):
    """Create one operator-owned Markdown playbook."""

    id: str = Field(min_length=1, max_length=64)
    content: str = Field(min_length=1, max_length=MAX_PLAYBOOK_BYTES)


class PlaybookUpdateRequest(BaseModel):
    """Replace one operator-owned Markdown playbook; the id remains immutable."""

    content: str = Field(min_length=1, max_length=MAX_PLAYBOOK_BYTES)
    expected_revision: int | None = Field(default=None, ge=1)


class PlaybookDryRunRequest(BaseModel):
    """Synthetic cluster attributes for deterministic procedure diagnostics."""

    rule_ids: list[str] = Field(default_factory=list, max_length=100)
    entity_type: EntityType = EntityType.RULE
    event_count: int = Field(default=1, ge=0, le=1_000_000)


def _raise_playbook_management_http(exc: Exception) -> None:
    if isinstance(exc, PlaybookNotFoundError):
        raise HTTPException(status_code=404, detail="playbook not found") from exc
    if isinstance(exc, PlaybookConflictError):
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if isinstance(exc, PlaybookProtectedError):
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    if isinstance(exc, PlaybookManagementError):
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    raise exc


@router.get("/playbooks")
async def playbooks(
    state: AppState = Depends(get_state),
    _=Depends(require_permission("playbooks", "read")),
) -> dict[str, Any]:
    await state.refresh_playbooks()
    pbs = state.playbooks.all()
    return {
        "enabled": state.prefs.playbooks.enabled,
        "count": len(pbs),
        "playbooks": [_playbook_payload(state, p) for p in pbs],
    }


@router.post("/playbooks")
async def playbooks_create(
    body: PlaybookCreateRequest,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("playbooks", "manage")),
) -> dict[str, Any]:
    """Create an operator Markdown file, atomically reload it, and audit the change.

    The front-matter id must equal ``body.id``.  IDs are slug/path constrained and
    a create never overwrites any existing file or bundled playbook.  Playbook text
    remains recommendation-only context; this endpoint never touches ``decide()``.
    """
    try:
        playbook, summary = await state.create_playbook(
            body.id,
            body.content,
            actor=current_username(request) or "operator",
        )
    except Exception as exc:  # mapped to bounded, non-path-leaking HTTP errors
        _raise_playbook_management_http(exc)
        raise AssertionError("unreachable")  # pragma: no cover
    await state.control_audit.record(
        action_type=ActionType.PLAYBOOK,
        surface="playbooks",
        actor=current_username(request) or "operator",
        result_summary=f"created operator playbook {playbook.id} v{playbook.version}",
    )
    return {"ok": True, "playbook": _playbook_payload(state, playbook), "reload": summary}


@router.post("/playbooks/reload")
async def playbooks_reload(
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("playbooks", "manage")),
) -> dict[str, Any]:
    """Hot-reload playbooks from disk (atomic; a broken file never replaces a good
    live set). Returns the load summary."""
    summary = await state.refresh_playbooks()
    await state.control_audit.record(
        action_type=ActionType.PLAYBOOK,
        surface="playbooks",
        actor=current_username(request) or "operator",
        result_summary=(
            f"reloaded playbooks loaded={summary.get('loaded', 0)} "
            f"skipped={len(summary.get('skipped', []))}"
        ),
    )
    return summary


@router.post("/playbooks/dry-run")
async def playbooks_dry_run(
    body: PlaybookDryRunRequest,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("playbooks", "read")),
) -> dict[str, Any]:
    """Explain exact match and no-match reasons without running an investigation."""
    await state.refresh_playbooks()
    rules = [str(value).strip() for value in body.rule_ids if str(value).strip()]
    cluster = Cluster(
        signature="playbook-dry-run",
        entity=Entity(type=body.entity_type, value="dry-run"),
        group_by=body.entity_type,
        rule_values=rules,
        count=body.event_count,
    )
    return state.playbooks.diagnose(cluster)


@router.get("/playbooks/coverage")
async def playbooks_coverage(
    state: AppState = Depends(get_state),
    _=Depends(require_permission("playbooks", "read")),
) -> dict[str, Any]:
    """Coverage over the stored case population, paged without a 200-row cap."""
    await state.refresh_playbooks()
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
            count = max(
                len(case.member_event_keys or []),
                len(case.member_event_ids or []),
                1,
            )
            cluster = Cluster(
                signature=case.cluster_signature,
                entity=case.entity,
                group_by=case.entity.type,
                rule_values=list(case.rule_ids or []),
                count=count,
            )
            chosen, _reason = state.playbooks.select(cluster)
            scanned += 1
            if chosen is not None:
                covered += 1
                selected_counts[chosen.id] = selected_counts.get(chosen.id, 0) + 1
            else:
                families = sorted({str(value).strip() for value in case.rule_ids if str(value).strip()}) or ["<no-rule-id>"]
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


@router.get("/playbooks/selection/{case_id}")
async def playbook_selection(
    case_id: str,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("cases", "read")),
) -> dict[str, Any]:
    """Why a given case selected the playbook it did (from the audit trail)."""
    case = await state.cases.get(case_id)
    reason = ""
    try:
        records = await state.audit.records_for_case(case_id)
        for r in records:
            actor = r.get("actor") if isinstance(r, dict) else getattr(r, "actor", "")
            if actor == "playbook_selector":
                reason = r.get("result_summary") if isinstance(r, dict) else getattr(r, "result_summary", "")
                break
    except Exception:  # noqa: BLE001 — explainability is best-effort
        reason = ""
    return {
        "case_id": case_id,
        "playbook_id": (case.playbook_id if case else ""),
        "reason": reason,
    }


@router.get("/playbooks/{playbook_id}")
async def playbook_detail(
    playbook_id: str,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("playbooks", "read")),
) -> dict[str, Any]:
    """Open one playbook as plain UTF-8 Markdown plus parsed catalog metadata."""
    await state.refresh_playbooks()
    try:
        playbook, content = state.playbooks.read_document(playbook_id)
    except Exception as exc:
        _raise_playbook_management_http(exc)
        raise AssertionError("unreachable")  # pragma: no cover
    return _playbook_payload(state, playbook, content=content)


@router.put("/playbooks/{playbook_id}")
async def playbook_update(
    playbook_id: str,
    body: PlaybookUpdateRequest,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("playbooks", "manage")),
) -> dict[str, Any]:
    """Atomically update an operator playbook. Bundled playbooks are read-only."""
    try:
        playbook, summary = await state.update_playbook(
            playbook_id,
            body.content,
            actor=current_username(request) or "operator",
            expected_revision=body.expected_revision,
        )
    except Exception as exc:
        _raise_playbook_management_http(exc)
        raise AssertionError("unreachable")  # pragma: no cover
    await state.control_audit.record(
        action_type=ActionType.PLAYBOOK,
        surface="playbooks",
        actor=current_username(request) or "operator",
        result_summary=f"updated operator playbook {playbook.id} v{playbook.version}",
    )
    return {"ok": True, "playbook": _playbook_payload(state, playbook), "reload": summary}


# --------------------------------------------------------------------------- #
# Metrics / analytics (deterministic aggregation over cases + the cost ledger)
# --------------------------------------------------------------------------- #
@router.get("/metrics")
async def metrics(window_hours: int = 24, state: AppState = Depends(get_state)) -> dict[str, Any]:
    cases, total = await state.cases.list(limit=2000)
    out = compute_metrics(cases, total_cases=total)
    try:
        out["cost"] = await state.usage_store.summary(window_hours=max(1, window_hours))
    except Exception:  # noqa: BLE001 — cost is best-effort on the metrics view
        out["cost"] = {}
    return out


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


async def _register_session(
    state: AppState, request: Request, token: str, *, mfa_method: str = "",
    refresh_hash: str = "",
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
        idle = int(getattr(policy, "idle_timeout", 0) or 0)
        absolute = int(getattr(policy, "absolute_lifetime", 0) or 0)
        meta = session_metadata(request)
        await sessions.create(
            sid=sid, username=username, token_version=tv,
            refresh_hash=refresh_hash or "",
            idle_timeout=idle, absolute_lifetime=absolute,
            mfa_method=mfa_method or "", **meta,
        )
        await _audit_session(
            state, "session_create", username, sid,
            f"new session ({meta.get('client_type', '') or 'unknown'} "
            f"{meta.get('ua_browser', '')}/{meta.get('ua_os', '')})".strip(),
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
    token = auth.authenticate(body.username, body.password)
    if not token:
        await state.control_audit.record(
            action_type=ActionType.AUTH_EVENT, surface="auth", actor=body.username or "",
            result_summary="login failed",
        )
        raise HTTPException(status_code=401, detail="invalid credentials")
    user = auth.principal(body.username) or auth.verify(token)
    # --- MFA phase 1 (Wave 2 / F3): the password is correct, but the user has MFA
    # enabled (or its role is enforced). Do NOT mint a session cookie/token here —
    # return a SHORT-LIVED pending token the client exchanges at /auth/mfa/verify
    # with a TOTP/recovery code. A user with mfa_enabled=False is UNAFFECTED. ---
    if auth.requires_mfa(user.username):
        await state.control_audit.record(
            action_type=ActionType.AUTH_EVENT, surface="auth", actor=user.username,
            result_summary="password ok; mfa challenge issued",
        )
        return {
            "requires_mfa": True,
            "pending_token": auth.begin_mfa(user.username),
        }
    # Best-effort: record the login timestamp (multi-user store only).
    try:
        await state.users.update(user.username, last_login_at=iso_now())
    except Exception:  # noqa: BLE001
        pass
    await state.control_audit.record(
        action_type=ActionType.AUTH_EVENT, surface="auth", actor=user.username,
        result_summary="login ok",
    )
    # Wave 3: register the session (sid/tv from the token) with request metadata.
    await _register_session(state, request, token, mfa_method="password")
    response.set_cookie(
        "tlsoc_token", token, httponly=True, samesite="lax",
        secure=state.secrets.auth_cookie_secure,
        max_age=state.secrets.auth_token_hours * 3600,
    )
    return {
        "token": token,
        "user": {
            "username": user.username,
            "role": _resolved_role(state, user),
            "must_change_password": bool(user.must_change_password),
            "mfa_enabled": bool(getattr(user, "mfa_enabled", False)),
        },
    }


@router.get("/auth/me")
async def auth_me(request: Request, state: AppState = Depends(get_state)) -> dict[str, Any]:
    auth = state.auth
    if not auth.is_enabled:
        return {"authenticated": True, "auth_enabled": False, "user": None}
    token = request.cookies.get("tlsoc_token") or _bearer(request)
    user = auth.verify(token) if token else None
    return {
        "authenticated": user is not None,
        "auth_enabled": True,
        "user": (
            {
                "username": user.username,
                "role": _resolved_role(state, user),
                "must_change_password": bool(user.must_change_password),
                "mfa_enabled": bool(getattr(user, "mfa_enabled", False)),
            }
            if user else None
        ),
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
            try:
                if await state.sessions.revoke(sid, by=username, reason="logout"):
                    await _audit_session(state, "session_revoke", username, sid, "logout")
            except Exception:  # noqa: BLE001
                pass
    # Mirror the set_cookie attributes so the cookie is reliably cleared.
    response.delete_cookie("tlsoc_token", samesite="lax", secure=state.secrets.auth_cookie_secure)
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
        raise HTTPException(status_code=400, detail="current password is incorrect")
    user = await state.users.get(principal.username)
    if user is None:
        raise HTTPException(
            status_code=400,
            detail="this account is managed via environment configuration and cannot self-change",
        )
    from ..auth.passwords import hash_password

    await state.users.update(
        principal.username,
        password_hash=hash_password(new_pw),
        must_change_password=False,
    )
    await state.refresh_users()
    await state.control_audit.record(
        action_type=ActionType.AUTH_EVENT, surface="auth", actor=principal.username,
        result_summary="password changed",
    )
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
    return {
        "sessions": [
            {**state.sessions.public(r), "current": bool(current_sid and r.get("sid") == current_sid)}
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
    ok = await state.sessions.revoke(sid, by=principal.username, reason="user_revoke")
    if ok:
        await _audit_session(state, "session_revoke", principal.username, sid, "self revoke")
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
    await _audit_session(
        state, "session_revoke_others", principal.username, keep,
        f"revoked {count} other session(s)",
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
        await _audit_session(
            state, "refresh_reuse", username, str((row or {}).get("sid") or ""),
            "refresh-token reuse detected — all sessions revoked",
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
    # The session must still be usable (not revoked/expired) to rotate.
    policy = _session_policy(state)
    reason = state.sessions.is_active(
        row, idle_timeout=int(getattr(policy, "idle_timeout", 0) or 0),
        absolute_lifetime=int(getattr(policy, "absolute_lifetime", 0) or 0),
    )
    if reason is not None:
        raise HTTPException(status_code=401, detail={"code": "session_expired", "reason": reason})
    minted = state.auth.mint_session(username)
    if minted is None:
        raise HTTPException(status_code=401, detail={"code": "session_invalid", "reason": "inactive_user"})
    token, _principal = minted
    # The NEW access token carries a NEW sid. Keep ONE logical session row by
    # RE-KEYING the existing row to the new sid + rotating its refresh hash (the old
    # refresh hash slides to refresh_prev_hash for theft detection). This preserves
    # the created_at anchor (absolute lifetime) while the access sid resolves.
    new_refresh = new_refresh_token()
    new_sid = str((state.auth.claims_of(token) or {}).get("sid") or "")
    await state.sessions.rekey_and_rotate(
        sid, new_sid, hash_refresh(new_refresh),
        idle_timeout=int(getattr(policy, "idle_timeout", 0) or 0),
    )
    await _audit_session(state, "refresh_rotate", username, new_sid, f"rotated from {_short(sid)}")
    response.set_cookie(
        "tlsoc_token", token, httponly=True, samesite="lax",
        secure=state.secrets.auth_cookie_secure,
        max_age=state.secrets.auth_token_hours * 3600,
    )
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
        await state.control_audit.record(
            action_type=ActionType.AUTH_EVENT, surface="session", actor=principal.username,
            result_summary="reauth failed",
        )
        raise HTTPException(status_code=401, detail={"code": "reauth_required", "reason": "bad_password"})
    sid = getattr(principal, "sid", "") or ""
    if sid:
        await state.sessions.stamp_authn(sid)
    await _audit_session(state, "session_reauth", principal.username, sid, "step-up re-auth ok")
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
    return {"sessions": [state.sessions.public(r) for r in rows]}


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
        await _audit_session(state, "session_admin_revoke", by, sid,
                             f"admin revoked session of {row.get('username', '')}")
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
    await _audit_session(state, "session_admin_revoke_all", by, "",
                         f"admin revoked all {count} session(s) for {username}")
    return {"ok": True, "revoked": count}


def _norm_user(username: str) -> str:
    return (username or "").strip().lower()


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
        patch["prefs"] = body.prefs
    if not patch:
        raise HTTPException(status_code=400, detail="no changes provided")
    updated = await state.users.update(principal.username, **patch)
    await state.refresh_users()
    await state.control_audit.record(
        action_type=ActionType.AUTH_EVENT, surface="account", actor=principal.username,
        result_summary=f"updated profile ({', '.join(sorted(patch))})",
    )
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
    updated = await state.users.update(principal.username, avatar=avatar)
    await state.refresh_users()
    await state.control_audit.record(
        action_type=ActionType.AUTH_EVENT, surface="account", actor=principal.username,
        result_summary=("cleared avatar" if not avatar else "updated avatar"),
    )
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
    await state.control_audit.record(
        action_type=ActionType.AUTH_EVENT, surface="auth", actor=principal.username,
        result_summary="mfa enrollment started",
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
    updated = user.model_copy(update={
        "mfa_enabled": True,
        "mfa_secret": obf,
        "mfa_recovery_hashes": list(pending["recovery_hashes"]),
        "mfa_last_step": int(step),
    })
    await state.users.save(updated)
    await state.refresh_users()
    _MFA_PENDING_ENROLL.pop(principal.username.strip().lower(), None)
    await state.control_audit.record(
        action_type=ActionType.AUTH_EVENT, surface="auth", actor=principal.username,
        result_summary="mfa enabled",
    )
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
            await state.users.save(user.model_copy(update={"mfa_last_step": int(step)}))
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
            await state.users.save(user.model_copy(update={"mfa_recovery_hashes": remaining}))
    if not method:
        await state.control_audit.record(
            action_type=ActionType.AUTH_EVENT, surface="auth", actor=username,
            result_summary="mfa verify failed",
        )
        raise HTTPException(status_code=401, detail="invalid code")
    await state.refresh_users()
    minted = auth.mint_session(username)
    if minted is None:  # pragma: no cover — username verified above
        raise HTTPException(status_code=401, detail="invalid credentials")
    token, principal = minted
    try:
        await state.users.update(username, last_login_at=iso_now())
    except Exception:  # noqa: BLE001
        pass
    await state.control_audit.record(
        action_type=ActionType.AUTH_EVENT, surface="auth", actor=username,
        result_summary=f"mfa login ok ({method})",
    )
    # Wave 3: register the session from the freshly-minted token (carries sid/tv).
    await _register_session(state, request, token, mfa_method=method)
    response.set_cookie(
        "tlsoc_token", token, httponly=True, samesite="lax",
        secure=state.secrets.auth_cookie_secure,
        max_age=state.secrets.auth_token_hours * 3600,
    )
    return {
        "token": token,
        "user": {
            "username": principal.username,
            "role": _resolved_role(state, principal),
            "must_change_password": bool(principal.must_change_password),
            "mfa_enabled": True,
        },
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
        raise HTTPException(status_code=400, detail="invalid code")
    await state.users.save(user.model_copy(update={
        "mfa_enabled": False, "mfa_secret": "", "mfa_recovery_hashes": [], "mfa_last_step": 0,
    }))
    await state.refresh_users()
    await state.control_audit.record(
        action_type=ActionType.AUTH_EVENT, surface="auth", actor=principal.username,
        result_summary="mfa disabled",
    )
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
        await state.control_audit.record(
            action_type=ActionType.AUTH_EVENT, surface="auth", actor=identity.get("email") or "",
            result_summary=f"sso denied: {denied}",
        )
        return _fail("not_allowed")
    role = prov.role_for(identity)
    username = await _provision_sso_user(state, provider_id, identity, role)
    if username is None:
        await state.control_audit.record(
            action_type=ActionType.AUTH_EVENT, surface="auth", actor=identity.get("email") or "",
            result_summary="sso login rejected: user not provisioned",
        )
        return _fail("user_not_provisioned")
    await state.refresh_users()
    minted = state.auth.mint_session(username)
    if minted is None:
        return _fail("session_failed")
    token, _principal = minted
    try:
        await state.users.update(username, last_login_at=iso_now())
    except Exception:  # noqa: BLE001
        pass
    await state.control_audit.record(
        action_type=ActionType.AUTH_EVENT, surface="auth", actor=username,
        result_summary=f"sso login ok ({provider_id})",
    )
    # Wave 3: register the SSO session from the freshly-minted token (carries sid/tv).
    await _register_session(state, request, token, mfa_method=f"sso:{provider_id}")
    redirect = RedirectResponse(url="/", status_code=302)
    redirect.set_cookie(
        "tlsoc_token", token, httponly=True, samesite="lax",
        secure=state.secrets.auth_cookie_secure,
        max_age=state.secrets.auth_token_hours * 3600,
    )
    redirect.delete_cookie(_OIDC_STATE_COOKIE, path="/")  # one-time binding consumed (#38)
    return redirect


async def _provision_sso_user(
    state: AppState, provider_id: str, identity: dict[str, Any], role: str
) -> str | None:
    """Map an SSO identity to a local account; provision it (atomically) when
    ``auto_create_users`` is on. Returns the local username, or ``None`` when no
    matching user exists and auto-provisioning is off.

    Matching precedence: an EXISTING user already linked to this (provider, sub) →
    (only when the IdP asserts a VERIFIED email) an existing SSO-managed user by that
    email → else (if allowed) create one. The account key is the verified email when
    available, else the non-spoofable ``provider:sub``. Idempotent: a returning user is
    NOT duplicated; its role is refreshed from the group map.

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
        return None  # no stable subject → cannot key an account safely
    # Only trust the email as an account key when the IdP asserts it is verified;
    # otherwise key on the immutable provider+sub (an attacker cannot forge that).
    trusted_email = email if (email and email_verified) else ""
    username = trusted_email or f"{provider_id}:{sub}"

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
                await state.control_audit.record(
                    action_type=ActionType.AUTH_EVENT, surface="auth",
                    actor=email or username,
                    result_summary=(
                        f"sso link refused: {provider_id} email matches a local account"
                    ),
                )
                return None
            existing = candidate

    if existing is not None:
        # Idempotent re-login: refresh role + provider linkage, never duplicate.
        if not existing.active:
            return None
        await state.users.save(existing.model_copy(update={
            "role": role if (cfg and cfg.group_role_map) else existing.role,
            "oauth_provider": provider_id,
            "oauth_sub": sub or existing.oauth_sub,
        }))
        return existing.username

    if not auto_create:
        return None
    # Atomic create-if-absent at our single-process scale (create() raises on a
    # concurrent duplicate, which we treat as "already provisioned").
    try:
        created = await state.users.create(
            username=username,
            password_hash=hash_password(secrets_token()),
            role=role,
            active=True,
            must_change_password=False,
        )
    except ValueError:
        # Raced with another callback that just created it — fetch + return.
        again = await state.users.get(username)
        return again.username if again else None
    await state.users.save(created.model_copy(update={
        "oauth_provider": provider_id, "oauth_sub": sub,
    }))
    return created.username


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
    state.secrets.set_sso_client_secret(provider_id, body.client_secret)
    await state.control_audit.record(
        action_type=ActionType.AUTH_EVENT, surface="auth", actor=current_username(request),
        result_summary=f"sso client secret {'set' if body.client_secret else 'cleared'} for '{provider_id}'",
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


class UserUpdateBody(BaseModel):
    role: str | None = None
    active: bool | None = None
    password: str | None = None
    # Wave 2 / F3 — a super_admin may FORCE-DISABLE another user's MFA (e.g. lost
    # device). Only False is honored here; enabling MFA is always a self-service
    # enroll (setup→confirm) so the user actually possesses the authenticator.
    mfa_enabled: bool | None = None


_VALID_ROLES = {r.value for r in UserRole}


def _validate_role(role: str) -> str:
    if role not in _VALID_ROLES:
        raise HTTPException(status_code=400, detail=f"unknown role: {role}")
    return role


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
    from ..auth.passwords import hash_password

    try:
        user = await state.users.create(
            username=body.username,
            password_hash=hash_password(pw),
            role=body.role,
            active=True,
            must_change_password=True,
        )
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    await state.refresh_users()
    await state.control_audit.record(
        action_type=ActionType.USER_MGMT, surface="users", actor=current_username(request),
        result_summary=f"created user '{user.username}' ({user.role})",
    )
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
    if not patch:
        raise HTTPException(status_code=400, detail="no changes provided")
    demoting = body.role is not None and body.role != UserRole.SUPER_ADMIN.value
    disabling = body.active is False
    if await _would_orphan_super_admin(state, target, demoting=demoting, disabling=disabling):
        raise HTTPException(
            status_code=409, detail="cannot demote or disable the last active super_admin"
        )
    updated = await state.users.update(username, **patch)
    await state.refresh_users()
    await state.control_audit.record(
        action_type=ActionType.USER_MGMT, surface="users", actor=current_username(request),
        result_summary=f"updated user '{username}'",
    )
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

    generation = account_generation(target.username, target.created_at)
    artifacts, _removed_jobs = await state.jobs.retire_actor(username, generation)
    await state.job_runner.delete_artifacts(artifacts)
    await state.users.delete(username)
    await state.auth.purge_user_side_state(
        username,
        inbox=state.real_inbox,
        notif_prefs=state.notif_prefs,
        user_prefs=state.user_prefs,
        custom_roles=state.custom_roles,
    )
    await state.refresh_users()
    await state.control_audit.record(
        action_type=ActionType.USER_MGMT, surface="users", actor=current_username(request),
        result_summary=f"deleted user '{username}'",
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


def _window_cases_by_created(
    cases: list[Case], from_expr: str | None, to_expr: str | None
) -> list[Case]:
    """Keep only cases whose ``created_at`` is within [from, to] (each bound optional).

    Bounds accept an ISO timestamp OR a relative ``now-24h`` expression (whatever the
    TimeRangePicker emits). Best-effort + never-drop-on-error (#4): a case with a
    missing/unparseable ``created_at`` is KEPT rather than silently excluded."""
    lo = relative_to_millis(from_expr) if from_expr else None
    hi = relative_to_millis(to_expr) if to_expr else None
    if lo is None and hi is None:
        return cases
    out: list[Case] = []
    for c in cases:
        ts = getattr(c, "created_at", "") or ""
        if not ts:
            out.append(c)
            continue
        try:
            ms = relative_to_millis(ts)
        except Exception:  # noqa: BLE001 — unparseable ts → keep (never silently drop)
            out.append(c)
            continue
        if lo is not None and ms < lo:
            continue
        if hi is not None and ms > hi:
            continue
        out.append(c)
    return out


def _with_advisory_bands(case: Case, prefs: Preferences) -> Case:
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


@router.get("/cases", response_model=CaseListResponse)
async def list_cases(
    status: str | None = None,
    surface: str | None = None,
    entity: str | None = None,
    limit: int = 50,
    offset: int = 0,
    from_: str | None = Query(default=None, alias="from"),
    to: str | None = Query(default=None),
    state: AppState = Depends(get_state),
    _=Depends(require_permission("cases", "read")),
) -> CaseListResponse:
    cases, total = await state.cases.list(
        status=status, source_surface=surface, entity_value=entity,
        limit=min(limit, 200), offset=offset,
    )
    # ADDITIVE (Round-6 #37): an OPTIONAL created_at time window so Overview widgets can
    # honor the TimeRangePicker. Default (both None) == byte-identical prior behaviour.
    # Cases sort created_at-desc, so a recent [from..to] window captures the front of the
    # returned page; when a window is active, ``total`` reflects the windowed count (what
    # the KPI widgets want). Full store-level windowing (accurate paged totals across the
    # whole corpus) is a follow-up handoff on the case store (foreign file).
    if from_ or to:
        cases = _window_cases_by_created(cases, from_, to)
        total = len(cases)
    # ADDITIVE (Round-7 W0.7): populate the read-time advisory bands (severity/impact/
    # urgency/priority) for the list surface. Fail-open per case — never 500 (#3).
    prefs = state.execution_prefs
    cases = [_with_advisory_bands(c, prefs) for c in cases]
    return CaseListResponse(cases=cases, total=total)


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
    return _with_advisory_bands(case, state.prefs)


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

# Terminal lifecycle statuses (a case here is DONE). A backward move out of a
# terminal status is only allowed via an explicit reopen.
_TERMINAL = {CaseStatus.CLOSED, CaseStatus.RESOLVED}


def _guard_transition(action: str, current: CaseStatus, target: CaseStatus | None) -> None:
    """Reject illegal lifecycle moves (e.g. CLOSED→NEW without reopen). Allows
    reopen explicitly out of a terminal status; allows same-status no-ops."""
    if target is None or target == current:
        return
    # Moving OUT of a terminal status is only legal via reopen/deescalate→reopen.
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
    return await _perform_case_action(case_id, body, actor, state)


async def _perform_case_action(
    case_id: str, body: CaseAction, actor: str, state: AppState
) -> dict[str, Any]:
    """Apply ONE human lifecycle action to ONE case — the SINGLE source of truth for
    the analyst-action path (used by the single-case endpoint AND the bulk endpoint).

    #3-safe: this is the HUMAN analyst layer ONLY. It NEVER calls
    ``case_manager.decide()`` and never runs the deterministic auto-close path; the
    close-axis truth table is untouched. Caller has already done the RBAC check +
    resolved ``actor``. Each call audits the transition individually (#2)."""
    case = await state.cases.get(case_id)
    if not case:
        raise HTTPException(status_code=404, detail="Case not found")
    if body.action not in _ACTION_STATUS:
        raise HTTPException(status_code=400, detail=f"Unknown action: {body.action}")

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

    # set_disposition: validate + set the investigative outcome (no status move).
    if body.action == "set_disposition":
        if not body.disposition:
            raise HTTPException(status_code=400, detail="set_disposition requires a disposition")
        try:
            case.disposition = Disposition(body.disposition)
        except ValueError:
            raise HTTPException(status_code=400, detail=f"unknown disposition: {body.disposition}")

    # confirm_fp records the FALSE_POSITIVE disposition (an analyst confirming an FP),
    # overriding only an unset / UNDETERMINED auto-mapping — never a deliberate
    # analyst classification.
    if body.action == "confirm_fp" and case.disposition in (None, Disposition.UNDETERMINED):
        case.disposition = Disposition.FALSE_POSITIVE

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
    if body.assignee is not None:
        case.assignee = str(body.assignee).strip()[:80]
    # tags → merge into the case's tags (trim, de-dupe, bounded — same tidy rules
    # as the dedicated /tags route).
    if body.tags is not None:
        merged = list(case.tags)
        for t in body.tags:
            t = str(t).strip()[:40]
            if t and t not in merged:
                merged.append(t)
        case.tags = merged[:25]

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
    if body.resolution is not None:
        entry["resolution"] = str(body.resolution)
    if body.priority is not None:
        entry["priority"] = str(body.priority)
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
            ),
        )
    except Exception as exc:  # noqa: BLE001 — audit is best-effort, never blocks the action
        logger.warning("Status audit failed for %s: %s", case_id, exc)
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
    return case.model_dump(mode="json")


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

    results: list[dict[str, Any]] = []
    seen: set[str] = set()
    for cid in ids:
        if cid in seen:
            continue  # de-dupe so a repeated id isn't applied (and audited) twice
        seen.add(cid)
        try:
            await _perform_case_action(cid, single, actor, state)
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
    return case.model_dump(mode="json")


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
    return case.model_dump(mode="json")


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
    # De-dupe, trim, cap length/count — tags are operator labels, kept tidy.
    seen: list[str] = []
    for t in body.tags:
        t = str(t).strip()[:40]
        if t and t not in seen:
            seen.append(t)
    case.tags = seen[:25]
    case.updated_at = iso_now()
    await state.cases.save(case)
    await state.audit.record(
        action_type=ActionType.COLLAB, surface="case", actor=body.analyst or "analyst",
        case_id=case_id, result_summary=f"tags set ({len(case.tags)})",
    )
    return case.model_dump(mode="json")


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
    case.assignee = body.assignee.strip()[:80]
    case.updated_at = iso_now()
    await state.cases.save(case)
    await state.audit.record(
        action_type=ActionType.COLLAB, surface="case", actor=body.analyst or "analyst",
        case_id=case_id, result_summary=f"assigned to {case.assignee or '(unassigned)'}",
    )
    return case.model_dump(mode="json")


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
        f"- **Persona:** {case.agent_persona or 'generalist'} · **Playbook:** {case.playbook_id or '—'}",
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
    return updated.model_dump(mode="json")


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
    return updated.model_dump(mode="json")


class RunPlaybookRequest(BaseModel):
    """Manually RUN a specific playbook on a case (F10). ``playbook_id`` selects the
    playbook to FORCE-inject as TRUSTED operator procedure for a re-investigation."""

    playbook_id: str
    analyst: str = "analyst"


@router.post("/cases/{case_id}/run-playbook")
async def case_run_playbook(
    case_id: str,
    body: RunPlaybookRequest,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("playbooks", "run")),
) -> dict[str, Any]:
    """Manually run a chosen playbook on a case (F10) — CONTEXT-ONLY, #3-safe.

    Re-investigates the case through the SHARED pipeline with ``playbook_id`` FORCED
    as the injected TRUSTED operator procedure. The playbook can only RECOMMEND; the
    deterministic close/escalate decision in the Case Manager is untouched (#3). 404
    if the case or playbook is unknown; 400 (NEUTRAL) when no events remain to rebuild
    the cluster. Returns the updated Case. Gated by ``playbooks:run``."""
    case = await state.cases.get(case_id)
    if not case:
        raise HTTPException(status_code=404, detail="Case not found")
    if state.playbooks.get(body.playbook_id) is None:
        raise HTTPException(status_code=404, detail=f"Unknown playbook: {body.playbook_id}")
    # Rebuild the cluster from live logs; if the events aged out, fall back to a
    # minimal reconstruction from the case's STORED evidence so the playbook can still
    # be run over what we retained rather than dead-ending (#3 untouched).
    query_source = state.active_source_for_id(case.source_id)
    cluster = await _cluster_for_case(
        state, case, allow_stored_reconstruction=True, query_source=query_source
    )
    if cluster is None:
        raise HTTPException(
            status_code=400,
            detail="This case has no stored evidence to reinvestigate.",
        )
    await state.audit.record(
        action_type=ActionType.DECISION, surface=case.source_surface.value,
        actor="run_playbook", case_id=case_id,
        result_summary=(
            f"manual playbook run requested by {body.analyst or 'analyst'}: "
            f"playbook={body.playbook_id}"
        ),
    )
    updated = await state.playbooks.run(
        state.pipeline, cluster, case.source_surface, state.execution_prefs, body.playbook_id,
        query_source=query_source,
    )
    return updated.model_dump(mode="json")


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


# Auto-widen ladder (BUG-2): increasing windows tried IN ORDER on 0 hits. The
# configured/requested start window is always tried first; ladder rungs narrower
# than the start are skipped so we never shrink the search below what was asked.
# ``now-365d`` is the ~1-year widest rung (the relative-time parser supports
# s/m/h/d/w, not a ``y`` unit, so a year is expressed in days).
_WIDEN_LADDER = ("now-7d", "now-30d", "now-365d")


def _entity_field(prefs: Preferences, entity_type: EntityType) -> str:
    return {
        EntityType.IP: prefs.source_ip_field,
        EntityType.USER: prefs.user_field,
        EntityType.HOST: prefs.host_field,
    }[entity_type]


def _scoped_entity_body(prefs: Preferences, field: str, value: str, from_millis: int) -> dict[str, Any]:
    """Entity query with the SAME scope + suppression filters the poller uses, so a
    manual investigation never pulls out-of-scope or suppressed events."""
    body = entity_query(
        prefs, field, value, from_millis=from_millis, size=200,
        extra_filters=scope_filters(prefs),
    )
    must_not = scope_must_not(prefs)
    if must_not:
        body["query"]["bool"]["must_not"] = must_not
    return body


def _widen_windows(start_window: str) -> list[str]:
    """Ordered windows to try: the configured/requested start, then each ladder
    rung that is WIDER than (i.e. reaches further back than) the start."""
    windows = [start_window]
    start_ms = relative_to_millis(start_window)
    for rung in _WIDEN_LADDER:
        # A wider window resolves to an EARLIER epoch (further in the past).
        if relative_to_millis(rung) < start_ms:
            windows.append(rung)
    return windows


async def _entity_events_widening(
    state: AppState,
    entity_type: EntityType,
    value: str,
    start_window: str,
    *,
    query_source=None,
) -> tuple[list[RawEvent], str]:
    """Fetch an entity's in-scope events, auto-widening the lookback on 0 hits.

    Returns (events, widest_window_tried). Stops at the first window that yields
    events; if all are empty the events list is empty and widest_window_tried is
    the broadest window attempted."""
    prefs = state.execution_prefs
    windows = _widen_windows(start_window)
    widest = windows[-1]
    for window in windows:
        if query_source is not None:
            from ..connectors.base import StructuredQuery

            filters: dict[str, Any] = {
                "time_from": window,
                "time_to": "now",
                "size": 200,
                "sort_desc": True,
            }
            if entity_type == EntityType.IP:
                filters["ip"] = value
            elif entity_type == EntityType.USER:
                filters["user"] = value
            elif entity_type == EntityType.HOST:
                filters["host"] = value
            elif entity_type == EntityType.RULE:
                filters["rule"] = value
            else:
                # The current source-neutral query IR has no hash/domain field;
                # do not silently query a different source as a fallback.
                return [], widest
            result = await query_source.search(prefs, StructuredQuery(**filters))
            events = result.events
        else:
            field = _entity_field(prefs, entity_type)
            body = _scoped_entity_body(prefs, field, value, relative_to_millis(window))
            resp = await state.es.search_logs(prefs.data_view_pattern, body)
            hits = resp.get("hits", {}).get("hits", [])
            events = [RawEvent.from_hit(h, prefs) for h in hits]
        if events:
            return events, window
    return [], widest


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
    """Rebuild a cluster from a stored case for a human-triggered re-investigation.

    Prefers an exact id-based re-query of the case's member events; falls back to a
    config-windowed (``prefs.investigate_lookback``) entity re-query using the same
    scope filters as the manual investigate path. Read-only on the log surface.

    When both live re-queries come back empty (the originating events aged out of the
    retained log window) AND ``allow_stored_reconstruction`` is set, a MINIMAL cluster
    is rebuilt from the case's STORED fields (see :func:`_reconstruct_cluster_from_case`)
    so an operator-triggered re-investigation can still run the LLM over the retained
    evidence instead of dead-ending on a 400. Callers that must NOT fabricate a cluster
    from stale state (e.g. the read-only forwarding explainer) leave the flag off and
    still get ``None``.

    The original deterministic trigger reason (if the case has one) is PRESERVED so
    a re-investigate never overwrites a scan-derived "Why this fired"; only a case
    lacking one gets a synthesized MANUAL trigger reason. Nothing here touches the
    deterministic close/escalate decision (#3)."""
    prefs = state.execution_prefs
    entity_type, value = case.entity.type, case.entity.value
    has_trigger = case.trigger_reason is not None
    # ``query_source=None`` is intentional for push/deleted sources: they have no
    # upstream search surface. Only legacy cases without source provenance may use
    # the implicit global ES client as a compatibility fallback.
    implicit_legacy_source = (
        not prefs.sources
        and case.source_id == getattr(state.log_source, "connector_id", None)
    )
    can_query_live = query_source is not None or not case.source_id or implicit_legacy_source

    def _finalize(cluster: Cluster, window: str) -> Cluster:
        # Re-investigation is an update of this exact stored case, not a fresh
        # correlation pass. Pin identity and provenance even when live events were
        # found; otherwise a legacy/manual case (or a source-scoping change) can
        # compute a new signature and mint a duplicate case.
        cluster.signature = case.cluster_signature
        cluster.source_id = case.source_id
        cluster.source_name = case.source_name
        # Only synthesize a manual reason when the case lacks one; otherwise leave
        # the cluster's reason None so the pipeline's _trigger() keeps the existing.
        if not has_trigger:
            cluster.trigger_reason = _manual_trigger_reason(cluster, window)
        else:
            cluster.trigger_reason = None
        return cluster

    # Preferred: re-fetch the exact member events by id (read-only).
    if case.member_event_ids and can_query_live:
        fetch_size = max(len(case.member_event_ids), len(case.member_event_keys or []))
        if query_source is not None:
            result = await query_source.fetch_by_ids(
                prefs, case.member_event_ids, size=fetch_size
            )
            events = result.events
        else:
            resp = await state.es.search_logs(
                prefs.data_view_pattern,
                ids_query(case.member_event_ids, size=fetch_size),
            )
            hits = resp.get("hits", {}).get("hits", [])
            events = [RawEvent.from_hit(h, prefs) for h in hits]
        members = [e for e in events if e.entity_value(entity_type) == value] or events
        if members:
            cluster = cluster_from_events(entity_type, value, members)
            return _finalize(cluster, prefs.investigate_lookback)

    # Fallback: re-query the entity over the configured window (with auto-widen).
    if can_query_live:
        events, window = await _entity_events_widening(
            state, entity_type, value, prefs.investigate_lookback,
            query_source=query_source,
        )
        if events:
            members = [e for e in events if e.entity_value(entity_type) == value] or events
            cluster = cluster_from_events(entity_type, value, members)
            return _finalize(cluster, window)

    # Last resort: the live logs aged out of the retained window. For an operator-
    # triggered re-investigation (reinvestigate / run-playbook), optionally rebuild a
    # MINIMAL cluster from the case's STORED evidence so the LLM can still re-reason
    # over what we retained. Read-only + fail-open; ``None`` only when the case carries
    # NO stored evidence at all. #3 untouched — this only reassembles evidence.
    if allow_stored_reconstruction:
        reconstructed = _reconstruct_cluster_from_case(case)
        if reconstructed is not None:
            return _finalize(reconstructed, prefs.investigate_lookback)
    return None


def _reconstruct_cluster_from_case(case: Case) -> Cluster | None:
    """Rebuild a MINIMAL cluster from a case's STORED fields when the live log
    re-query is empty (the originating events aged out of the retained window).

    Lets an operator-triggered re-investigation still run the investigator over the
    case's retained evidence rather than dead-ending. Synthetic member events are
    reconstructed (capped at 200) from the stored ``member_event_ids`` (falling back
    to the ``evidence[].event_ids``), each carrying the case entity + a stored rule so
    the investigator prompt and the deterministic risk model see faithful inputs. The
    cluster SIGNATURE is PINNED to the case's stored ``cluster_signature`` so the
    re-investigation updates THIS case in place and never mints a duplicate (#4).

    Read-only + fail-open: returns ``None`` only when the case carries no stored
    evidence at all. Nothing here touches the deterministic decision (#3)."""
    entity_type = case.entity.type
    value = case.entity.value

    # Stored evidence ids: prefer the member events, else the verdict evidence ids.
    raw_ids: list[str] = list(case.member_event_ids or [])
    if not raw_ids:
        for item in case.evidence:
            raw_ids.extend(item.event_ids or [])
    ordered_ids: list[str] = []
    seen: set[str] = set()
    for eid in raw_ids:
        if eid and eid not in seen:
            seen.add(eid)
            ordered_ids.append(eid)
        if len(ordered_ids) >= 200:
            break
    if not ordered_ids:
        return None  # truly-empty case — nothing to reconstruct.

    # Window from the stored trigger reason (else collapse to a point-in-time window).
    tr = case.trigger_reason
    win_start = int(tr.window_start) if (tr and tr.window_start) else 0
    win_end = int(tr.window_end) if (tr and tr.window_end) else 0
    if win_end < win_start:
        win_start, win_end = win_end, win_start

    rules = [r for r in (case.rule_ids or []) if r]
    n = len(ordered_ids)
    members: list[RawEvent] = []
    for i, eid in enumerate(ordered_ids):
        if win_start and win_end and n > 1:
            ts = win_start + (win_end - win_start) * i // (n - 1)
        else:
            ts = win_start or win_end or 0
        ev = RawEvent(
            id=eid,
            timestamp_millis=ts,
            rule=(rules[i % len(rules)] if rules else None),
            source={"reconstructed": True},
        )
        # Carry the case entity onto its projection field so the investigator prompt
        # + reproduce query render the concrete entity (UNTRUSTED log data downstream).
        if entity_type == EntityType.IP:
            ev.ip = value
        elif entity_type == EntityType.USER:
            ev.user = value
        elif entity_type == EntityType.HOST:
            ev.host = value
        members.append(ev)

    cluster = cluster_from_events(entity_type, value, members)
    # Preserve stored provenance + counts the synthetic events cannot carry, and PIN
    # the signature so the re-investigation updates THIS case in place (#4).
    cluster.signature = case.cluster_signature
    if case.rule_ids:
        cluster.rule_values = list(case.rule_ids)
    cluster.source_id = case.source_id
    cluster.source_name = case.source_name
    cluster.member_event_keys = list(case.member_event_keys or cluster.member_event_keys)
    # The stored member id list may exceed the 200-event synthetic cap — keep the
    # faithful volume for the deterministic risk model (recomputed by the pipeline).
    cluster.count = max(
        len(members), len(case.member_event_keys or case.member_event_ids)
    )
    if case.risk_score:
        cluster.risk_score = case.risk_score
        cluster.risk_breakdown = case.risk_breakdown
    return cluster


def _manual_trigger_reason(cluster: Cluster, window: str) -> TriggerReason:
    """Synthesize a MANUAL TriggerReason so "Why this fired" renders for manually
    investigated cases (Feature 3 / IMPROVEMENT). Mode is ``manual``; structured
    fields are filled from the resolved cluster."""
    entity_type = cluster.entity.type.value
    entity_value = cluster.entity.value
    n = cluster.count
    rules = ", ".join(cluster.rule_values) or "no specific rule"
    sentence = (
        f"Manually investigated: {n} event{'s' if n != 1 else ''} for "
        f"{entity_type} {entity_value} in the last {window} across rules [{rules}]"
    )
    return TriggerReason(
        rule_value=(cluster.rule_values[0] if cluster.rule_values else ""),
        mode="manual",
        n=n,
        window_seconds=0,
        group_by=entity_type,
        observed_count=n,
        window_start=cluster.first_seen_millis,
        window_end=cluster.last_seen_millis,
        entity=f"{entity_type}:{entity_value}",
        rule_values=list(cluster.rule_values),
        sentence=sentence,
    )


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


def _audit_get(row: Any, key: str, default: Any = None) -> Any:
    """Read a field from an audit row that may be a dict OR a pydantic AuditDoc."""
    if isinstance(row, dict):
        return row.get(key, default)
    return getattr(row, key, default)


def _build_rationale(case_id: str, case: Any, rows: list[Any]) -> dict[str, Any]:
    """Assemble the explainability "why" object from a case + its audit rows.

    Pure + defensive: any missing audit piece degrades to an empty value. Reads the
    CONTEXT record (knowledge/memory/enrichment), TOOL_CALL records (tools/queries),
    the VERDICT record (reasoning excerpt), the playbook_selector DECISION (playbook
    reason) and the case_manager DECISION (deterministic rationale)."""
    # Audit rows are OLDEST-first.  A case can be re-investigated many times, so
    # project only the LATEST run instead of mixing the first run's context/tools
    # with the current Case fields.  ``playbook_selector`` is the usual durable run
    # boundary (including the cheap path).  A failure can happen before selection,
    # though; in that case the terminal ``pipeline error:`` row must start a new run
    # rather than inheriting the previous run's measured retrieval or other artifacts.
    # The prefix deliberately excludes the non-terminal timeout ERROR row: timeout
    # handling continues to procedure provenance + the deterministic case-manager
    # decision in the SAME run.  Legacy audit histories without either boundary fall
    # back to their full history.
    run_start = 0
    run_boundary_reason = "historical_provenance_missing"
    last_selector = -1
    last_terminal = -1
    for idx, row in enumerate(rows):
        if _audit_get(row, "actor") == "playbook_selector":
            run_start = idx
            run_boundary_reason = "historical_provenance_missing"
            last_selector = idx
        elif (
            _audit_get(row, "actor") == "pipeline"
            and _audit_get(row, "action_type") == ActionType.ERROR.value
            and str(_audit_get(row, "result_summary") or "").startswith("pipeline error:")
        ):
            # No selector has appeared since the preceding completed run: this
            # failure itself is the latest run boundary.  If the current run DID
            # reach selection, retain that more informative boundary so any measured
            # retrieval completed before the later failure remains attributable.
            if last_selector <= last_terminal:
                run_start = idx
                run_boundary_reason = "pipeline_failed_before_provenance"
            last_terminal = idx
        elif (
            _audit_get(row, "actor") == "case_manager"
            and _audit_get(row, "action_type") == ActionType.DECISION.value
        ):
            last_terminal = idx

    # The fail-to-human Case is persisted before its terminal audit row. If that
    # best-effort append was lost but older audit history remains readable, an error
    # Case would otherwise inherit the preceding run. A newer Case timestamp is
    # positive evidence that the bounded audit trail has no boundary for this run;
    # fail closed to an empty/unavailable projection instead of guessing.
    case_error = str(_audit_get(case, "error") or "").strip()
    case_updated_at = parse_es_timestamp(_audit_get(case, "updated_at"))
    audit_times = [
        parsed
        for row in rows
        if (parsed := parse_es_timestamp(_audit_get(row, "ts"))) is not None
    ]
    if case_error and case_updated_at is not None and (
        not audit_times or max(audit_times) < case_updated_at
    ):
        run_start = len(rows)
        run_boundary_reason = "pipeline_failure_provenance_missing"
    run_rows = rows[run_start:]

    selector_row = next(
        (row for row in reversed(run_rows) if _audit_get(row, "actor") == "playbook_selector"),
        None,
    )
    context_row = next(
        (
            row
            for row in reversed(run_rows)
            if _audit_get(row, "action_type") == ActionType.CONTEXT.value
            and _audit_get(row, "actor") == "context"
        ),
        None,
    )
    procedure_row = next(
        (
            row
            for row in reversed(run_rows)
            if _audit_get(row, "action_type") == ActionType.CONTEXT.value
            and _audit_get(row, "actor") == "procedure_provenance"
        ),
        None,
    )

    # --- from the CONTEXT record (investigator-injected context) -------------
    knowledge: list[dict[str, Any]] = []
    memory_used: list[str] = []
    enrichment: dict[str, Any] | None = None
    playbook_id = ""
    playbook_version = ""
    playbook_consulted = False
    if context_row is not None:
        ti = _audit_get(context_row, "tool_input") or {}
        if isinstance(ti, dict):
            for k in (ti.get("knowledge") or []):
                if isinstance(k, dict):
                    knowledge.append({
                        "source": str(k.get("source", "unknown")),
                        "snippet": str(k.get("snippet", "")),
                    })
            for m in (ti.get("memory") or []):
                if isinstance(m, str) and m.strip():
                    memory_used.append(m)
            enr = ti.get("enrichment")
            if isinstance(enr, dict):
                enrichment = {
                    "reputation_score": enr.get("reputation_score"),
                    "is_malicious": enr.get("is_malicious"),
                    "country": enr.get("country"),
                }
            detail = ti.get("playbook_detail")
            if isinstance(detail, dict) and str(detail.get("id") or "").strip():
                playbook_id = str(detail.get("id") or "").strip()
                playbook_version = str(detail.get("version") or "").strip()
                playbook_consulted = True
            elif ti.get("playbook"):
                # Backward compatibility for pre-structured CONTEXT rows.  The Case
                # id belongs to the latest run, and a truthy context value proves it
                # was actually injected (selection alone does not).
                playbook_id = str(getattr(case, "playbook_id", "") or "").strip()
                playbook_consulted = bool(playbook_id)

    # --- exact selected-vs-consulted procedure provenance ------------------
    # New runs write this independently of the legacy investigator CONTEXT row,
    # including cheap-router, kill-switch, and timeout paths where a persona or
    # playbook may be selected but never consulted.  Keep a stable empty shape for
    # old audit histories so consumers do not need to infer usage from Case fields.
    procedure_provenance: dict[str, Any] = {
        "persona": {"selected_id": "", "selection_reason": "", "consulted": False},
        "playbook": {"selected_id": "", "selection_reason": "", "consulted": False},
        "consultation_path": "",
        # Missing procedure telemetry is UNKNOWN, never a measured zero.
        "retrieval_status": "unavailable",
        "retrieval_reason": run_boundary_reason,
        "retrieval_query_groups": [],
        "knowledge": [],
    }
    if procedure_row is not None:
        procedure_input = _audit_get(procedure_row, "tool_input") or {}
        if isinstance(procedure_input, dict):
            for key in ("persona", "playbook"):
                raw = procedure_input.get(key)
                if not isinstance(raw, dict):
                    continue
                procedure_provenance[key] = {
                    "selected_id": str(raw.get("selected_id") or ""),
                    "selection_reason": str(raw.get("selection_reason") or ""),
                    "consulted": bool(raw.get("consulted", False)),
                }
            procedure_provenance["consultation_path"] = str(
                procedure_input.get("consultation_path") or ""
            )
            raw_retrieval_status = str(
                procedure_input.get("retrieval_status") or "unavailable"
            )
            retrieval_status = (
                raw_retrieval_status
                if raw_retrieval_status
                in {"measured", "not_attempted", "unavailable"}
                else "unavailable"
            )
            procedure_provenance["retrieval_status"] = retrieval_status
            procedure_provenance["retrieval_reason"] = str(
                procedure_input.get("retrieval_reason")
                or (
                    "historical_provenance_missing"
                    if retrieval_status == "unavailable"
                    else ""
                )
            )
            for item in procedure_input.get("retrieval_query_groups") or []:
                if not isinstance(item, dict):
                    continue
                procedure_provenance["retrieval_query_groups"].append({
                    "group": str(item.get("group") or ""),
                    "query": str(item.get("query") or ""),
                })
            for item in procedure_input.get("knowledge") or []:
                if not isinstance(item, dict):
                    continue
                procedure_provenance["knowledge"].append({
                    "source": str(item.get("source") or "unknown"),
                    "score": item.get("score"),
                    "document_id": str(item.get("document_id") or ""),
                    "revision": item.get("revision"),
                    "content_hash": str(item.get("content_hash") or ""),
                    "query_groups": [
                        str(value)
                        for value in (item.get("query_groups") or [])
                        if str(value)
                    ],
                    "snippet": str(item.get("snippet") or ""),
                })

        # The explicit row is authoritative. A selected procedure on a cheap path
        # must not be resurrected as "used" from mutable Case fields or an older
        # context row. Structured knowledge also supersedes the legacy two-field list.
        playbook_provenance = procedure_provenance["playbook"]
        playbook_consulted = bool(playbook_provenance["consulted"])
        if playbook_consulted:
            playbook_id = str(playbook_provenance["selected_id"] or playbook_id)
        else:
            playbook_id = ""
            playbook_version = ""
        knowledge = list(procedure_provenance["knowledge"])

    # --- platform threshold tuning snapshot (run-boundary audit row) ---------
    platform_tuning_status = "not_recorded"
    platform_tuning: list[dict[str, Any]] = []
    if selector_row is not None:
        selector_input = _audit_get(selector_row, "tool_input") or {}
        if isinstance(selector_input, dict):
            raw_tuning = selector_input.get("platform_tuning")
            if isinstance(raw_tuning, dict):
                raw_status = str(raw_tuning.get("status") or "not_recorded")
                if raw_status in {"recorded", "not_recorded", "unavailable"}:
                    platform_tuning_status = raw_status
                for item in raw_tuning.get("records") or []:
                    if not isinstance(item, dict):
                        continue
                    platform_tuning.append({
                        "record_id": str(item.get("record_id") or ""),
                        "target": str(item.get("target") or ""),
                        "rule_id": str(item.get("rule_id") or ""),
                        "before": item.get("before"),
                        "after": item.get("after"),
                        "applied_at": str(item.get("applied_at") or ""),
                        "rationale": str(item.get("rationale") or ""),
                    })

    # --- tools / queries (TOOL_CALL + ES_QUERY rows) -------------------------
    tools: list[dict[str, Any]] = []
    for row in run_rows:
        at = _audit_get(row, "action_type")
        if at not in (ActionType.TOOL_CALL.value, ActionType.ES_QUERY.value):
            continue
        tools.append({
            "tool": _audit_get(row, "tool_name") or (
                "es_query" if at == ActionType.ES_QUERY.value else ""
            ),
            "query": _audit_get(row, "query_text") or "",
            "summary": _audit_get(row, "tool_output_summary") or "",
        })

    # --- reasoning excerpt (VERDICT record, written after "reasoning=") -------
    reasoning = ""
    for row in reversed(run_rows):
        if _audit_get(row, "action_type") != ActionType.VERDICT.value:
            continue
        rs = str(_audit_get(row, "result_summary") or "")
        marker = "reasoning="
        if marker in rs:
            reasoning = rs.split(marker, 1)[1].strip()
        break

    # --- playbook reason (playbook_selector DECISION) ------------------------
    playbook_reason = ""
    if selector_row is not None:
        selector_input = _audit_get(selector_row, "tool_input") or {}
        if isinstance(selector_input, dict):
            selection = selector_input.get("playbook_selection")
            if isinstance(selection, dict):
                playbook_reason = str(selection.get("reason") or "")
        if not playbook_reason:
            playbook_reason = str(_audit_get(selector_row, "result_summary") or "")

    # --- deterministic decision rationale (case_manager DECISION, then the
    #     case.history "decision" event as a fallback) ------------------------
    decision_rationale = ""
    for row in reversed(run_rows):
        if (
            _audit_get(row, "actor") == "case_manager"
            and _audit_get(row, "action_type") == ActionType.DECISION.value
        ):
            decision_rationale = str(_audit_get(row, "result_summary") or "")
            break

    # --- case-derived fields (defensive: case may be None) -------------------
    verdict = ""
    confidence = 0.0
    status = ""
    decision_by = None
    persona = ""
    mitre: list[str] = []
    evidence: list[dict[str, Any]] = []
    if case is not None:
        verdict = case.verdict.value if case.verdict else ""
        confidence = case.confidence
        status = case.status.value if case.status else ""
        decision_by = case.decision_by.value if case.decision_by else None
        persona = case.agent_persona or ""
        mitre = list(case.mitre or [])
        evidence = [
            {
                "summary": e.summary,
                "event_ids": list(e.event_ids or []),
                "query": e.query,
            }
            for e in (case.evidence or [])
        ]
        if not decision_rationale:
            for h in reversed(case.history or []):
                if isinstance(h, dict) and h.get("event") == "decision" and h.get("rationale"):
                    decision_rationale = str(h.get("rationale"))
                    break

    return {
        "case_id": case_id,
        "verdict": verdict,
        "confidence": confidence,
        "status": status,
        "decision_by": decision_by,
        "persona": persona,
        "procedure_provenance": procedure_provenance,
        "playbook": {
            "id": playbook_id,
            "version": playbook_version,
            "reason": playbook_reason,
            "consulted": playbook_consulted,
        },
        "memory_used": memory_used,
        "knowledge": knowledge,
        "platform_tuning_status": platform_tuning_status,
        "platform_tuning": platform_tuning,
        "enrichment": enrichment,
        "tools": tools,
        "reasoning": reasoning,
        "decision_rationale": decision_rationale,
        "mitre": mitre,
        "evidence": evidence,
    }


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
