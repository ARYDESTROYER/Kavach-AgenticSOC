"""Enrichment-provider HTTP routes (Round 3 Wave 2 / Feature 7).

A small, self-contained router (mounted by the integrator) exposing the multi-provider
threat-intel layer to the UI:

  * ``GET  /api/enrichment/providers``: every provider's manifest + whether it is
    enabled by config + whether its key(s) are configured (booleans only, never
    values, #10) + its free-tier note. ``enrichment:read``.
  * ``GET  /api/enrichment/lookup?indicator=&kind=``: enrich one observable across the
    capable, enabled providers (Redis-cached by the dispatcher). The ``kind`` is
    auto-detected when omitted. Every provider string is FENCED as UNTRUSTED before it
    is returned (#9); the fused reputation uses the byte-identical default ``max()``.
    ``enrichment:read``.
  * ``PUT  /api/enrichment/config``: change the enrichment settings (the master
    switch, fusion, a provider's ``use_*`` toggle, the cache lifetime), audited before
    the change is visible, refused while the settings lock is on. ``enrichment:manage``.
  * ``POST /api/enrichment/providers/{name}/secrets``: set/clear a provider's
    SECRET-tier key(s) IN MEMORY (env/in-memory only, never persisted, never returned),
    audited before the key changes (an ``enrichment.secrets_updated`` row naming the
    keys, never their values). ``enrichment:manage``.

Demo Mode (Round 14 SPEC §3.5, wro-01): the listing and the settings write use the
SAME settings, those of the active stack (:attr:`AppState.enrichment_settings`): the
real settings, or while Demo Mode is on the Demo sandbox's own copy, which a save
changes and which vanishes when Demo Mode ends or is reset. A save never reaches the
real settings while Demo Mode is on, and its row goes to the Demo audit. The sandbox
never queries a provider whatever its switches say (the execution copy forces lookups
off); the listing says so with ``demo_active`` instead of reporting the forced value
as the setting, so a switch always shows what its save changes. ``demo_run_id`` names
the Demo run the settings belong to (a reset starts a new run with a fresh copy), so a
page that read one run can tell when it reads another. Provider keys are not part of
the copy: they are real in-memory secrets whatever the Demo state, and their rows go to
the real audit log.

This router NEVER touches the deterministic decision (#3): it only fetches advisory
context. It owns NO module-level state: the registry + secrets live on ``AppState``.
"""

from __future__ import annotations

import ipaddress
import logging
import re
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, ValidationError

from ..audit.changes import changed_values, count_changes, diff_changes
from ..audit.context import audit_context
from ..audit.prefs_write import (
    SETTINGS_WRITE_ATTEMPTS,
    SettingsMovedError,
    settings_conflict,
    settings_target,
)
from ..audit.settings_write import ExecutionStack
from ..audit.write import audited_write
from ..config import EnrichmentConfig
from ..constants import ActionType, IndicatorKind
from ..enrichment.aggregate import fence_provider_result, fuse
from ..enrichment.dispatch import enrich_indicator as _dispatch
from ..models import AuditChange, AuditTarget
from ..state import AppState
from .deps import current_username, get_state, require_permission

logger = logging.getLogger("tlsoc.api.enrichment")
router = APIRouter(prefix="/api")


# --------------------------------------------------------------------------- #
# Indicator-kind auto-detection (used when the caller omits ?kind=)
# --------------------------------------------------------------------------- #
_HASH_RE = re.compile(r"^[a-fA-F0-9]{32}$|^[a-fA-F0-9]{40}$|^[a-fA-F0-9]{64}$")
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def detect_kind(indicator: str) -> IndicatorKind:
    """Best-effort classification of a raw observable into an :class:`IndicatorKind`.

    Order matters: an IP literal is unambiguous; an md5/sha1/sha256 hex string is a
    file hash; an ``a@b.c`` is an email; anything with a scheme or path is a URL; the
    rest is treated as a domain (the broadest fallback)."""
    s = (indicator or "").strip()
    try:
        ipaddress.ip_address(s)
        return IndicatorKind.IP
    except ValueError:
        pass
    if _HASH_RE.match(s):
        return IndicatorKind.FILE_HASH
    if _EMAIL_RE.match(s):
        return IndicatorKind.EMAIL
    # A scheme or any path component ⇒ a URL; a bare ``host.tld`` ⇒ a domain.
    if "://" in s or "/" in s:
        return IndicatorKind.URL
    return IndicatorKind.DOMAIN


def _coerce_kind(raw: str | None, indicator: str) -> IndicatorKind:
    if raw:
        try:
            return IndicatorKind(raw.lower())
        except ValueError as exc:
            valid = ", ".join(k.value for k in IndicatorKind)
            raise HTTPException(
                status_code=400, detail=f"invalid kind '{raw}'; one of: {valid}"
            ) from exc
    return detect_kind(indicator)


# --------------------------------------------------------------------------- #
# GET /api/enrichment/providers: manifests + configured booleans
# --------------------------------------------------------------------------- #
@router.get("/enrichment/providers")
async def list_enrichment_providers(
    state: AppState = Depends(get_state),
    _=Depends(require_permission("enrichment", "read")),
) -> dict[str, Any]:
    """Every registered provider's manifest + its current config/key state.

    Returns booleans only for secrets (``configured`` per field + an overall
    ``key_present``): never a secret value (#10). The switch states are the active
    stack's enrichment settings, the same ones ``PUT /api/enrichment/config`` changes
    (module doc): in Demo Mode the sandbox's copy, never the execution copy whose
    lookups are forced off. ``demo_active`` says that no provider is queried while
    Demo Mode is on and that a change here lasts only until it ends; ``demo_run_id``
    names that Demo run (``None`` off Demo Mode)."""
    reg = state.enrichment_registry
    # One read for the whole response (no await between them), so every switch, the
    # Demo flag and the run id describe the same stack.
    demo_active = state.demo_active
    demo_run_id = state.demo_run_id
    cfg = state.enrichment_settings
    secrets = state.secrets
    out: list[dict[str, Any]] = []
    for cls in sorted(reg.classes(), key=lambda c: getattr(c, "name", "")):
        try:
            m = cls.manifest()
        except Exception as exc:  # noqa: BLE001 (one bad provider never breaks the listing)
            logger.warning("manifest() failed for %s: %s", cls, exc)
            continue
        secret_state = {
            f.key: bool(getattr(secrets, f.key, None)) for f in m.secret_fields
        }
        out.append(
            {
                "name": m.name,
                "display_name": m.display_name or m.name,
                "description": m.description,
                "indicator_kinds": [k.value for k in m.indicator_kinds],
                "config_key": m.config_key,
                "enabled_by_config": cls.enabled_by_config(cfg),
                "keyless": m.keyless or not m.secret_fields,
                "key_present": cls.key_present(secrets),
                "secret_fields": [
                    {
                        "key": f.key,
                        "label": f.label,
                        "required": f.required,
                        "help": f.help,
                        "help_link": f.help_link,
                        "configured": secret_state.get(f.key, False),
                    }
                    for f in m.secret_fields
                ],
                "free_tier": m.free_tier,
                "docs_url": m.docs_url,
                "default_enabled": m.default_enabled,
                "version": m.version,
                # Round 11: fixed manifest UI copy: an ordered operator setup guide
                # + a one-line "how this helps triage" example (trusted, hard-coded
                # strings; never derived from provider responses).
                "setup_steps": [str(s) for s in m.setup_steps],
                "example": m.example,
            }
        )
    return {
        "enrichment_enabled": bool(getattr(cfg, "enabled", True)),
        "fusion_enabled": bool(getattr(cfg, "fusion_enabled", False)),
        "cache_ttl_seconds": int(getattr(cfg, "cache_ttl_seconds", 0) or 0),
        "demo_active": demo_active,
        "demo_run_id": demo_run_id,
        "providers": out,
    }


# --------------------------------------------------------------------------- #
# PUT /api/enrichment/config: change the enrichment settings (active stack)
# --------------------------------------------------------------------------- #
#: The editable fields and the JSON type each must carry. Every ``EnrichmentConfig``
#: field is a switch except the cache lifetime; the table is derived from the model so
#: a provider added later is editable with no change here.
_INT_FIELDS: frozenset[str] = frozenset({"cache_ttl_seconds"})

#: The longest cache lifetime this route saves: 30 days. Provider reputation older than
#: that is stale for triage, and the bound keeps the value inside every store's range
#: (a Redis expiry, an Elasticsearch ``long``), so a typo can never make every cache
#: write fail over to the in-memory cache.
CACHE_TTL_MAX_SECONDS = 30 * 24 * 60 * 60

#: The answer while the settings lock (``read_only_settings_mode``) is on: the words of
#: ``PUT /api/settings``, which saved these settings before Round 14.
_READ_ONLY_DETAIL = "Settings are in read-only mode"


def _editable_fields() -> dict[str, type]:
    return {
        name: (int if name in _INT_FIELDS else bool)
        for name in EnrichmentConfig.model_fields
    }


def _config_body_schema() -> dict[str, Any]:
    """The request body's OpenAPI schema, from the same table the route checks: one
    boolean per switch, the cache lifetime as a bounded integer, nothing else, at
    least one field. Documentation only: :func:`_validated_edit` enforces it."""
    properties: dict[str, Any] = {}
    for name, kind in _editable_fields().items():
        if kind is int:
            properties[name] = {"type": "integer", "minimum": 0,
                                "maximum": CACHE_TTL_MAX_SECONDS}
        else:
            properties[name] = {"type": "boolean"}
    return {
        "type": "object",
        "title": "EnrichmentConfigEdit",
        "description": "A partial of the enrichment settings: only the fields sent change.",
        "properties": properties,
        "additionalProperties": False,
        "minProperties": 1,
    }


def _validated_edit(body: Any) -> dict[str, Any]:
    """The request body as a checked edit, or ``422`` (a pre-check: no row).

    Strict on purpose: an unknown field, a switch sent as anything but ``true`` or
    ``false``, or a cache lifetime that is not a whole number of seconds from 0 to
    :data:`CACHE_TTL_MAX_SECONDS` is refused, so a typo or a coerced string can never
    save a value nobody chose."""
    if not isinstance(body, dict) or not body:
        raise HTTPException(
            status_code=422,
            detail="Send at least one enrichment setting, for example {\"use_rdap\": true}.",
        )
    fields = _editable_fields()
    unknown = sorted(str(k) for k in body if k not in fields)
    if unknown:
        raise HTTPException(
            status_code=422,
            detail=f"Unknown enrichment setting(s): {unknown}.",
        )
    for key, value in body.items():
        if fields[key] is bool and not isinstance(value, bool):
            raise HTTPException(
                status_code=422, detail=f"{key} must be true or false.",
            )
        if fields[key] is int and (
            isinstance(value, bool) or not isinstance(value, int)
            or not 0 <= value <= CACHE_TTL_MAX_SECONDS
        ):
            raise HTTPException(
                status_code=422,
                detail=(f"{key} must be a whole number of seconds from 0 to "
                        f"{CACHE_TTL_MAX_SECONDS} (30 days)."),
            )
    return dict(body)


def _settings_locked(state: AppState) -> bool:
    """Whether the settings lock is on. It lives in the REAL settings and holds with
    Demo Mode on or off, as it did when these saves went through ``PUT /api/settings``
    (the lock can be turned on while Demo Mode runs)."""
    return bool(getattr(state.prefs, "read_only_settings_mode", False))


def _refuse_while_locked(state: AppState) -> None:
    if _settings_locked(state):
        raise HTTPException(status_code=403, detail=_READ_ONLY_DETAIL)


def _apply_edit(current: EnrichmentConfig, patch: dict[str, Any]) -> EnrichmentConfig:
    """``current`` with ``patch`` applied, through the model's own validation (a copy
    with ``update=`` would skip it, so a constraint added to ``EnrichmentConfig`` later
    would never be enforced here). A value the model refuses answers ``422``."""
    try:
        return EnrichmentConfig.model_validate({**current.model_dump(mode="json"), **patch})
    except ValidationError as exc:
        raise HTTPException(
            status_code=422, detail=f"Invalid enrichment settings: {exc.errors()[0]['msg']}",
        ) from exc


class _EnrichmentSwap:
    """The edit as the store applies it (the settings compare-and-swap of
    :mod:`app.audit.prefs_write`, on the enrichment block): the planned result when the
    block is the one the row described, else the same edit re-applied to the stored
    block, provided it still changes exactly the recorded fields from and to exactly
    the recorded values; otherwise :class:`SettingsMovedError` and a fresh attempt.

    It also re-reads the settings lock, in the store's own step (under the settings
    write lock for the real settings): a lock turned on after the row was appended
    refuses the save (``403``, the failure row beside the action row says it was not
    applied)."""

    def __init__(self, edit: Any, snapshot: EnrichmentConfig, after: EnrichmentConfig,
                 recorded: dict[str, Any], locked: Any) -> None:
        self._edit = edit
        self._snapshot = snapshot
        self._after = after
        self._recorded = recorded
        self._locked = locked

    def __call__(self, current: EnrichmentConfig) -> EnrichmentConfig:
        if self._locked():
            raise HTTPException(status_code=403, detail=_READ_ONLY_DETAIL)
        if current is self._snapshot:
            return self._after
        fresh = self._edit(current)
        if changed_values(current.model_dump(mode="json"),
                          fresh.model_dump(mode="json")) != self._recorded:
            raise SettingsMovedError()
        return fresh


def _actor(request: Request) -> str:
    try:
        return current_username(request) or ""
    except Exception:  # noqa: BLE001 (no resolvable principal; audit anonymously)
        return ""


class EnrichmentConfigSaveResult(BaseModel):
    """The answer of ``PUT /api/enrichment/config``."""

    ok: bool = True
    #: False when the request changed nothing (no save, no audit row).
    changed: bool
    #: Whether the settings saved (or read) are the Demo sandbox's copy.
    demo_active: bool
    #: The Demo run those settings belong to; ``None`` off Demo Mode.
    demo_run_id: str | None = None
    #: The enrichment settings after the request, of the stack it was saved to.
    config: EnrichmentConfig


@router.put(
    "/enrichment/config",
    response_model=EnrichmentConfigSaveResult,
    openapi_extra={
        "requestBody": {"content": {"application/json": {"schema": _config_body_schema()}}},
    },
)
async def put_enrichment_config(
    body: dict[str, Any],
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("enrichment", "manage")),
) -> EnrichmentConfigSaveResult:
    """Change the enrichment settings of the active stack (module doc).

    The body is a partial of ``EnrichmentConfig`` (``{"use_spamhaus": true}``); only
    the fields sent change. Audited before it is visible (#2, Round 14 SPEC §3.6): a
    ``settings.updated`` row naming every changed field is appended first, and a failed
    append answers ``503 audit_unavailable`` with nothing saved. Off Demo Mode this saves
    the real settings and the row goes to the real audit log; while Demo Mode is on it
    changes the Demo sandbox's copy only and the row goes to the Demo audit (SPEC §3.5).
    While the settings lock is on it answers ``403`` and saves nothing, with Demo Mode
    on or off. Demo Mode turned on or off (or reset) during the save answers ``409
    demo_mode_changed`` and saves nothing; a save racing another save of the same fields
    is retried from a fresh read and gives up with ``409 settings_conflict``. A body
    that changes nothing saves nothing and writes no row. Never touches ``decide()``
    (#3)."""
    patch = _validated_edit(body)
    _refuse_while_locked(state)

    def _edit(current: EnrichmentConfig) -> EnrichmentConfig:
        return _apply_edit(current, patch)

    # The stack this write is planned against, bound once (one synchronous step): its
    # Demo generation, its audit log and its run id. A retry never crosses into another
    # stack, and a reset (a disable and an enable) moves the generation too.
    stack = ExecutionStack(state)
    in_demo = state.demo_active
    run_id = state.demo_run_id
    sink: Any = stack.audit if in_demo else "control"
    save = stack.guard(state.mutate_enrichment_settings)
    actor = _actor(request)
    context = audit_context(request)
    fields = ", ".join(sorted(patch))
    total = max(1, SETTINGS_WRITE_ATTEMPTS)
    for attempt in range(total):
        stack.check()
        # A pre-check on every attempt (no row): the lock may have been turned on while
        # an earlier attempt raced another save.
        _refuse_while_locked(state)
        snapshot = state.enrichment_settings
        after = _edit(snapshot)
        before_doc = snapshot.model_dump(mode="json")
        after_doc = after.model_dump(mode="json")
        recorded = changed_values(before_doc, after_doc)
        if not recorded:
            return EnrichmentConfigSaveResult(
                changed=False, demo_active=in_demo, demo_run_id=run_id, config=snapshot,
            )
        changes = diff_changes(before_doc, after_doc, prefix="enrichment")
        summary = f"updated enrichment settings: {fields}"
        total_changes = count_changes(before_doc, after_doc)
        if total_changes > len(changes):
            summary = (f"{summary} ({total_changes} fields changed; "
                       f"the first {len(changes)} are recorded)")
        swap = _EnrichmentSwap(_edit, snapshot, after, recorded,
                               locked=lambda: _settings_locked(state))
        try:
            saved = await audited_write(
                state,
                sink=sink,
                action="settings.updated",
                target=settings_target(changes, default_id="enrichment",
                                       default_label="Enrichment"),
                expected_revision=None,
                changes=changes,
                write=lambda swap=swap: save(swap),
                action_type=ActionType.STATUS,
                actor=actor,
                surface="settings",
                context=context,
                result_summary=summary[:1000],
                tool_input=None if attempt == 0 else {"attempt": attempt + 1, "of": total},
            )
        except SettingsMovedError:
            logger.info("Enrichment settings save raced another save (attempt %d of %d)",
                        attempt + 1, total)
            continue
        return EnrichmentConfigSaveResult(
            changed=True, demo_active=in_demo, demo_run_id=run_id, config=saved,
        )
    raise settings_conflict()


# --------------------------------------------------------------------------- #
# GET /api/enrichment/lookup: enrich one observable
# --------------------------------------------------------------------------- #
@router.get("/enrichment/lookup")
async def enrichment_lookup(
    indicator: str = Query(..., min_length=1, description="The observable to enrich"),
    kind: str | None = Query(None, description="IndicatorKind; auto-detected if omitted"),
    state: AppState = Depends(get_state),
    _=Depends(require_permission("enrichment", "read")),
) -> dict[str, Any]:
    """Enrich one indicator across the capable, enabled providers (cached, fenced).

    The fused reputation uses the byte-identical default ``max()`` (#3 untouched);
    every provider-returned string is FENCED as UNTRUSTED before it is returned (#9).
    ``not_queried`` says why no provider was asked: ``"demo_mode"`` (Demo Mode never
    queries one) or ``"disabled"`` (the master switch is off); ``None`` otherwise."""
    value = (indicator or "").strip()
    if not value:
        raise HTTPException(status_code=400, detail="indicator is required")
    ik = _coerce_kind(kind, value)
    demo_active = state.demo_active
    cfg = state.execution_prefs.enrichment
    not_queried: str | None = None
    if demo_active or not cfg.enabled:
        # Demo Mode is an offline synthetic sandbox. Even a keyless enrichment
        # provider performs real HTTP/DNS traffic, so return the normal neutral
        # fail-open shape without dispatching anything.
        not_queried = "demo_mode" if demo_active else "disabled"
        results = []
    else:
        try:
            results = await _dispatch(
                value, ik, cfg, state.secrets, cache=state.cache,
                registry=state.enrichment_registry,
            )
        except Exception as exc:  # noqa: BLE001 (fail-open: a lookup never 500s the UI)
            logger.warning("enrichment lookup failed for %s (%s): %s", value, ik.value, exc)
            results = []
    fused = fuse(results, cfg)
    return {
        "indicator": value,
        "kind": ik.value,
        "reputation_score": fused.reputation_score,
        "is_malicious": fused.is_malicious,
        "method": fused.method,
        "country": fused.country,
        "per_provider": fused.per_provider,
        "queried": len(results),
        "not_queried": not_queried,
        # Every provider string fenced UNTRUSTED before it leaves the backend (#9).
        "providers": [fence_provider_result(r) for r in results],
    }


# --------------------------------------------------------------------------- #
# POST /api/enrichment/providers/{name}/secrets: set in-memory secret(s)
# --------------------------------------------------------------------------- #
class ProviderSecretsBody(BaseModel):
    """Map of ``secret_key -> value`` (value=None/"" clears). Only keys the provider's
    manifest declares are accepted; unknown keys are rejected (400)."""

    secrets: dict[str, str | None]


def _secret_names_summary(name: str, updates: dict[str, str | None]) -> str:
    """``"credentials of enrichment provider 'otx': otx_api_key set"``: key NAMES and
    whether each was set or cleared, never a value (#10)."""
    parts = [
        f"{key} {'cleared' if not updates[key] else 'set'}" for key in sorted(updates)
    ]
    return f"credentials of enrichment provider '{name}': {', '.join(parts)}"[:1000]


@router.post("/enrichment/providers/{name}/secrets")
async def set_enrichment_secrets(
    name: str,
    body: ProviderSecretsBody,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("enrichment", "manage")),
) -> dict[str, Any]:
    """Set/clear a provider's SECRET-tier key(s) IN MEMORY (env/in-memory only).

    Values are written onto the in-process ``Secrets`` object (never persisted, never
    returned, #10). Only the keys the provider's manifest declares may be set: an
    unknown key is a 400 so a typo can never silently set a dead field.

    Round 14 (SPEC §3.6, §4.5.4): audited before the key changes, like the source and
    notification channel credentials. An ``enrichment.secrets_updated`` row naming each
    key (``secret: true``, never its value) goes to the real audit log first, with Demo
    Mode on or off: the keys are real secrets, never part of the Demo copy. A failed
    append answers ``503 audit_unavailable`` and no key changes. A body with no key
    changes nothing and writes no row."""
    cls = state.enrichment_registry.get(name)
    if cls is None:
        raise HTTPException(status_code=404, detail=f"unknown provider '{name}'")
    allowed = set(cls.secret_keys())
    if not allowed:
        raise HTTPException(status_code=400, detail=f"provider '{name}' is keyless")
    unknown = set(body.secrets) - allowed
    if unknown:
        raise HTTPException(
            status_code=400,
            detail=f"unknown secret field(s) for '{name}': {sorted(unknown)}; allowed: {sorted(allowed)}",
        )
    updates = dict(body.secrets)
    if updates:
        try:
            label = cls.manifest().display_name or name
        except Exception:  # noqa: BLE001 (a broken manifest still lets a key be set)
            label = name

        async def _write() -> None:
            for key, value in updates.items():
                # In-memory SECRET tier: set on the live Secrets object; None/"" clears it.
                setattr(state.secrets, key, (value or None))

        await audited_write(
            state,
            sink="control",
            action="enrichment.secrets_updated",
            target=AuditTarget(type="setting", id=f"enrichment.providers[{name}]",
                               label=label),
            expected_revision=None,
            changes=[
                AuditChange(field=f"enrichment.providers[{name}].secrets.{key}",
                            before=None, after=None, secret=True)
                for key in sorted(updates)
            ],
            write=_write,
            action_type=ActionType.STATUS,
            actor=_actor(request),
            surface="settings",
            context=audit_context(request),
            result_summary=_secret_names_summary(name, updates),
        )
    configured = {k: bool(getattr(state.secrets, k, None)) for k in sorted(allowed)}
    return {
        "ok": True,
        "provider": name,
        "configured": configured,
        "key_present": cls.key_present(state.secrets),
    }


__all__ = ["CACHE_TTL_MAX_SECONDS", "EnrichmentConfigSaveResult", "router", "detect_kind"]
