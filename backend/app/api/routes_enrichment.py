"""Enrichment-provider HTTP routes (Round 3 Wave 2 / Feature 7).

A small, self-contained router (mounted by the integrator) exposing the multi-provider
threat-intel layer to the UI:

  * ``GET  /api/enrichment/providers`` — every provider's manifest + whether it is
    enabled by config + whether its key(s) are configured (booleans only, never
    values, #10) + its free-tier note. ``enrichment:read``.
  * ``GET  /api/enrichment/lookup?indicator=&kind=`` — enrich one observable across the
    capable, enabled providers (Redis-cached by the dispatcher). The ``kind`` is
    auto-detected when omitted. Every provider string is FENCED as UNTRUSTED before it
    is returned (#9); the fused reputation uses the byte-identical default ``max()``.
    ``enrichment:read``.
  * ``POST /api/enrichment/providers/{name}/secrets`` — set/clear a provider's
    SECRET-tier key(s) IN MEMORY (env/in-memory only, never persisted, never returned).
    ``enrichment:manage``.

This router NEVER touches the deterministic decision (#3): it only fetches advisory
context. It owns NO module-level state — the registry + secrets live on ``AppState``.
"""

from __future__ import annotations

import ipaddress
import logging
import re
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from ..constants import IndicatorKind
from ..enrichment.aggregate import fence_provider_result, fuse
from ..enrichment.dispatch import enrich_indicator as _dispatch
from ..state import AppState
from .deps import get_state, require_permission

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
# GET /api/enrichment/providers — manifests + configured booleans
# --------------------------------------------------------------------------- #
@router.get("/enrichment/providers")
async def list_enrichment_providers(
    state: AppState = Depends(get_state),
    _=Depends(require_permission("enrichment", "read")),
) -> dict[str, Any]:
    """Every registered provider's manifest + its current config/key state.

    Returns booleans only for secrets (``configured`` per field + an overall
    ``key_present``) — never a secret value (#10)."""
    reg = state.enrichment_registry
    cfg = state.execution_prefs.enrichment
    secrets = state.secrets
    out: list[dict[str, Any]] = []
    for cls in sorted(reg.classes(), key=lambda c: getattr(c, "name", "")):
        try:
            m = cls.manifest()
        except Exception as exc:  # noqa: BLE001 — one bad provider never breaks listing
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
                # Round 11: fixed manifest UI copy — an ordered operator setup guide
                # + a one-line "how this helps triage" example (trusted, hard-coded
                # strings; never derived from provider responses).
                "setup_steps": [str(s) for s in m.setup_steps],
                "example": m.example,
            }
        )
    return {
        "enrichment_enabled": bool(getattr(cfg, "enabled", True)),
        "fusion_enabled": bool(getattr(cfg, "fusion_enabled", False)),
        "providers": out,
    }


# --------------------------------------------------------------------------- #
# GET /api/enrichment/lookup — enrich one observable
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
    every provider-returned string is FENCED as UNTRUSTED before it is returned (#9)."""
    value = (indicator or "").strip()
    if not value:
        raise HTTPException(status_code=400, detail="indicator is required")
    ik = _coerce_kind(kind, value)
    cfg = state.execution_prefs.enrichment
    if state.demo_active or not cfg.enabled:
        # Demo Mode is an offline synthetic sandbox. Even a keyless enrichment
        # provider performs real HTTP/DNS traffic, so return the normal neutral
        # fail-open shape without dispatching anything.
        results = []
    else:
        try:
            results = await _dispatch(
                value, ik, cfg, state.secrets, cache=state.cache,
                registry=state.enrichment_registry,
            )
        except Exception as exc:  # noqa: BLE001 — fail-open: a lookup never 500s the UI
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
        # Every provider string fenced UNTRUSTED before it leaves the backend (#9).
        "providers": [fence_provider_result(r) for r in results],
    }


# --------------------------------------------------------------------------- #
# POST /api/enrichment/providers/{name}/secrets — set in-memory secret(s)
# --------------------------------------------------------------------------- #
class ProviderSecretsBody(BaseModel):
    """Map of ``secret_key -> value`` (value=None/"" clears). Only keys the provider's
    manifest declares are accepted; unknown keys are rejected (400)."""

    secrets: dict[str, str | None]


@router.post("/enrichment/providers/{name}/secrets")
async def set_enrichment_secrets(
    name: str,
    body: ProviderSecretsBody,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("enrichment", "manage")),
) -> dict[str, Any]:
    """Set/clear a provider's SECRET-tier key(s) IN MEMORY (env/in-memory only).

    Values are written onto the in-process ``Secrets`` object (never persisted, never
    returned, #10). Only the keys the provider's manifest declares may be set — an
    unknown key is a 400 so a typo can never silently set a dead field."""
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
    for key, value in body.secrets.items():
        # In-memory SECRET tier: set on the live Secrets object; None/"" clears it.
        setattr(state.secrets, key, (value or None))
    configured = {k: bool(getattr(state.secrets, k, None)) for k in sorted(allowed)}
    return {
        "ok": True,
        "provider": name,
        "configured": configured,
        "key_present": cls.key_present(state.secrets),
    }


__all__ = ["router", "detect_kind"]
