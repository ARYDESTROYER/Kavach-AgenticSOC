"""Whether the AI agent can call a model at all (Round 15 SPEC D2.1).

The setup wizard used to call any configured OpenAI or Anthropic key "a live provider",
even when the default investigation models belonged to another provider: an
Anthropic-only workspace read "Ready for live triage" while every investigation failed
for want of the OpenAI key and waited for a person as Needs human review. This module
answers the honest question instead: can the two roles that investigate a case, the
router and the investigator (``Preferences.model_for``), both reach their provider with
the credentials this process holds?

It mirrors what the one gateway needs before it sends a request
(``LLMGateway._provider_kwargs`` and ``_resolve_endpoint``):

* ``openai``, ``anthropic``: the provider's key (``Secrets.provider_key``);
* ``openai_compatible``: ``litellm_api_key`` or ``openai_api_key``, or a base URL that
  resolves for the model (``ModelConfig.base_url``, then the bundled registry's
  ``base_url_for``, then the operator's custom-model store), since a no-auth
  self-hosted server needs no key;
* ``azure``: a key (``azure_openai_api_key`` or ``openai_api_key``) and an endpoint
  (the role's base URL or ``azure_openai_endpoint``);
* ``bedrock``: the access key id and the secret access key;
* ``vertex``: the access token and the project;
* ``mock``: ready only in Demo Mode, whose deterministic runtime it is.

Pure and synchronous: the caller loads the custom-model map (``CustomModelStore.get()``,
already fail-soft) and passes it in. It reads credentials only to test that they are
set; it never returns, logs or hashes a value. It makes no model call (#6) and has no
bearing on ``decide()`` (#3).
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Literal, TypedDict

from .pricing import base_url_for

#: The provider families the readiness answer names (a closed vocabulary: the Console
#: maps each to its label and never shows the raw token).
AiRuntimeProvider = Literal[
    "openai", "anthropic", "openai_compatible", "azure", "bedrock", "vertex", "mock"
]

PROVIDER_TOKENS: tuple[str, ...] = (
    "openai", "anthropic", "openai_compatible", "azure", "bedrock", "vertex", "mock",
)

#: The roles that must both be callable before a cluster can be investigated.
INVESTIGATION_ROLES: tuple[str, ...] = ("investigator", "router")


class AiRuntimeStatus(TypedDict):
    """``ready``: both investigation roles can be called. ``provider``: the provider
    family the answer is about (the first role that cannot be called, else the
    investigator's), always one of :data:`PROVIDER_TOKENS`."""

    ready: bool
    provider: str


def _set(value: Any) -> bool:
    return bool(str(value or "").strip())


def _custom_base_url(custom_models: Mapping[str, Any] | None, model: str) -> str:
    if not custom_models or not model:
        return ""
    row = custom_models.get(model)
    if not isinstance(row, Mapping):
        return ""
    return str(row.get("base_url") or "").strip()


def resolved_base_url(cfg: Any, custom_models: Mapping[str, Any] | None = None) -> str:
    """The endpoint the gateway would use for ``cfg``: its own ``base_url``, then the
    bundled registry's, then the custom-model store's (``gateway._resolve_endpoint``
    and ``_provider``), else ``""``."""
    own = str(getattr(cfg, "base_url", "") or "").strip()
    if own:
        return own
    model = str(getattr(cfg, "model", "") or "").strip()
    registry = (base_url_for(model) or "").strip() if model else ""
    if registry:
        return registry
    return _custom_base_url(custom_models, model)


def provider_token(cfg: Any) -> str:
    """The provider family of ``cfg`` as a closed-vocabulary token."""
    raw = str(getattr(cfg, "provider", "") or "").strip().lower()
    return raw if raw in PROVIDER_TOKENS else "mock"


def role_ready(
    secrets: Any,
    cfg: Any,
    custom_models: Mapping[str, Any] | None = None,
    *,
    demo: bool = False,
) -> bool:
    """Whether the gateway could call the model ``cfg`` names (module doc)."""
    provider = provider_token(cfg)
    if provider == "mock":
        return bool(demo)
    if provider in ("openai", "anthropic"):
        return _set(secrets.provider_key(provider))
    if provider == "openai_compatible":
        return _set(secrets.provider_key("openai_compatible")) or bool(
            resolved_base_url(cfg, custom_models)
        )
    if provider == "azure":
        endpoint = resolved_base_url(cfg, custom_models) or str(
            getattr(secrets, "azure_openai_endpoint", "") or ""
        ).strip()
        return _set(secrets.provider_key("azure")) and bool(endpoint)
    if provider == "bedrock":
        return _set(getattr(secrets, "aws_access_key_id", None)) and _set(
            getattr(secrets, "aws_secret_access_key", None)
        )
    if provider == "vertex":
        return _set(getattr(secrets, "vertex_api_key", None)) and _set(
            getattr(secrets, "vertex_project", None)
        )
    return False  # pragma: no cover - provider_token keeps the vocabulary closed


def ai_runtime_status(
    secrets: Any,
    prefs: Any,
    custom_models: Mapping[str, Any] | None = None,
    *,
    demo: bool = False,
) -> AiRuntimeStatus:
    """``{ready, provider}`` for the investigation roles of ``prefs`` (module doc).

    ``provider`` names the first role (investigator, then router) that cannot be
    called, so "Add a key for {provider}" points at the missing credential; when both
    can be called it is the investigator's provider. ``demo`` is whether Demo Mode is
    on (the mock runtime is ready only then)."""
    first_unready = ""
    first = ""
    for role in INVESTIGATION_ROLES:
        cfg = prefs.model_for(role)
        token = provider_token(cfg)
        first = first or token
        if not first_unready and not role_ready(secrets, cfg, custom_models, demo=demo):
            first_unready = token
    return {"ready": not first_unready, "provider": first_unready or first or "mock"}


async def load_custom_models(state: Any) -> Mapping[str, Any]:
    """The operator's custom-model map for :func:`ai_runtime_status`, or ``{}``. The
    store is fail-soft already; a missing store or any error degrades to ``{}`` (a
    keyless self-hosted model then reads as not ready until its endpoint resolves)."""
    store = getattr(state, "custom_models", None)
    if store is None:
        return {}
    try:
        models = await store.get()
    except Exception:  # noqa: BLE001 (readiness is advisory; never fail the caller)
        return {}
    return models if isinstance(models, Mapping) else {}


async def ai_runtime_status_for(state: Any) -> AiRuntimeStatus:
    """:func:`ai_runtime_status` for the running app (its real settings, its secrets,
    its custom models and whether Demo Mode is on)."""
    return ai_runtime_status(
        state.secrets,
        state.prefs,
        await load_custom_models(state),
        demo=bool(getattr(state, "demo_active", False)),
    )


__all__ = [
    "INVESTIGATION_ROLES",
    "PROVIDER_TOKENS",
    "AiRuntimeProvider",
    "AiRuntimeStatus",
    "ai_runtime_status",
    "ai_runtime_status_for",
    "load_custom_models",
    "provider_token",
    "resolved_base_url",
    "role_ready",
]
