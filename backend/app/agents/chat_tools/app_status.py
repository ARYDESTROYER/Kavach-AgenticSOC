"""``app_status``: what this deployment is running and what the caller may do (SPEC §5.3).

The Help Center describes what the product CAN do; this tool says what THIS
deployment does: its version and documentation line, whether Demo Mode is on, which
capabilities are enabled, whether credentials are configured (booleans only), what the
caller's own access covers, and — with ``models:read`` — which model serves each role.

Kinds (``kind`` input):

* ``overview`` (default) — version, Demo Mode, enabled capabilities, source counts and
  configured-credential booleans;
* ``access`` — the caller's grants: chat tools they can and cannot use, and console
  areas that need a grant they lack;
* ``models`` (``models:read``) — the role → provider assignment; the model ids
  themselves are operator-chosen names and travel as untrusted operator values;
* ``config`` (``settings:read``) — typed policy detail: budget, auto-close policy,
  autopilot profile, polling and the chat bounds.

Secrets never leave the secret tier: only ``configured`` booleans are reported, and
only when the tool context exposes a ``secrets_status`` callable. Operator-named
values (organisation name, source display names, model ids) are NOT product facts:
they go to ``observation["operator_values"]``, which ``render_app_docs`` fences as
untrusted data after the trusted block. Every chat caller holds ``cases:read`` (the
chat routes require it), which is why it is this tool's base grant: it keeps the
ungated kinds available while ``models``/``config`` add their own grant through the
standard per-kind check (a refusal is audited once by the toolbox).
"""

from __future__ import annotations

from typing import Any, ClassVar, Literal

from ...knowledge import (
    app_knowledge_status,
    console_link,
    docs_line_for,
    get_app_knowledge,
    warm_app_knowledge,
)
from .base import Artifact, ChatTool, ChatToolContext, ToolOutcome
from .common import ToolInput, parse_input

StatusKind = Literal["overview", "access", "models", "config"]
_ROLE_FIELDS: tuple[tuple[str, str], ...] = (
    ("router", "router_model"), ("investigator", "investigator_model"),
    ("formatter", "formatter_model"), ("standup", "standup_model"), ("chat", "chat_model"),
    ("overview", "overview_model"), ("embedding", "embedding_model"),
)
# Configured-credential booleans worth stating (LLM and enrichment keys). Anything not
# a plain bool (per-provider maps keyed by operator ids) is never reported.
_KEY_GROUPS: dict[str, tuple[str, ...]] = {
    "model_providers": (
        "openai_api_key", "anthropic_api_key", "litellm_api_key", "azure_openai_api_key",
        "aws_access_key_id", "aws_secret_access_key", "vertex_project", "vertex_api_key",
        "embedding_api_key",
    ),
    "log_store": ("es_api_key", "es_mgmt_api_key"),
}
# Provider -> the ways its credential can be configured: each alternative is a tuple of
# ``Secrets.configured_status`` keys that must ALL be set (mirrors
# ``Secrets.provider_key``: Azure falls back to the OpenAI key, an OpenAI-compatible
# endpoint to its LiteLLM key or the OpenAI key; Bedrock needs the key id AND secret).
_PROVIDER_KEYS: dict[str, tuple[tuple[str, ...], ...]] = {
    "openai": (("openai_api_key",),),
    "anthropic": (("anthropic_api_key",),),
    "azure": (("azure_openai_api_key",), ("openai_api_key",)),
    "bedrock": (("aws_access_key_id", "aws_secret_access_key"),),
    "vertex": (("vertex_api_key",),),
    "openai_compatible": (("litellm_api_key",), ("openai_api_key",)),
}
# Providers that can run without any key: the simulated provider, and a self-hosted
# OpenAI-compatible server that needs no authentication.
_KEY_OPTIONAL = frozenset({"mock", "openai_compatible"})
_MAX_AREAS_PER_GRANT = 5
_MAX_SOURCE_NAMES = 20


class AppStatusInput(ToolInput):
    kind: StatusKind = "overview"


class AppStatusTool(ChatTool):
    name: ClassVar[str] = "app_status"
    label: ClassVar[str] = "Checked this deployment"
    scope: ClassVar[str] = "docs"
    requires: ClassVar[tuple[tuple[str, str], ...]] = (("cases", "read"),)
    kind_permissions: ClassVar[dict[str, tuple[str, str]]] = {
        "models": ("models", "read"),
        "config": ("settings", "read"),
    }
    signature: ClassVar[str] = (
        "app_status(kind?=overview|access|models|config) — this deployment's version, Demo "
        "Mode, enabled capabilities, configured credentials (yes/no only), the user's own "
        "access, the model per role (models) or policy settings (config)"
    )
    data_source: ClassVar[str] = "This deployment's configuration (no secrets)"
    display_keys: ClassVar[tuple[str, ...]] = ("kind",)

    async def run(self, ctx: ChatToolContext, **inp: Any) -> ToolOutcome:
        parsed, failure = parse_input(AppStatusInput, inp)
        if failure is not None:
            return failure
        # The builders read the corpus synchronously; build it off the event loop first
        # (an unavailable corpus only removes the console links and locked areas).
        await warm_app_knowledge()
        kind: str = parsed.kind
        builder = {
            "overview": _overview, "access": _access, "models": _models, "config": _config,
        }[kind]
        facts, operator_values, kpis = builder(ctx)
        observation: dict[str, Any] = {
            "kind": "app_status",
            "status_kind": kind,
            "available": True,
            "facts": facts,
        }
        if operator_values:
            observation["operator_values"] = operator_values
        links = _console_links(ctx, kind)
        if links:
            observation["console_targets"] = [
                {"id": l.id, "label": l.label, "requires": l.requires, "allowed": l.allowed}
                for l in links
            ]
        artifacts: list[Artifact] = []
        if kpis:
            artifacts.append(Artifact(
                id="a1", kind="kpis", title=_KPI_TITLES[kind], title_trusted=True,
                data={"items": kpis}, provenance="code",
            ))
        guide_links = [
            {"label": f"Open {l.label}", "ref": {"page": l.page, **({"opts": dict(l.opts)} if l.opts else {})}}
            for l in links if l.allowed
        ]
        if guide_links:
            artifacts.append(Artifact(
                id=f"a{len(artifacts) + 1}", kind="guide", title="Where to change it",
                title_trusted=True, data={"steps": [], "links": guide_links[:6]}, provenance="code",
            ))
        return ToolOutcome(
            ok=True,
            summary=_SUMMARIES[kind],
            observation=observation,
            artifacts=artifacts,
            sources=["Deployment configuration"],
            console_links=[l.id for l in links],
        )


_KPI_TITLES = {
    "overview": "Deployment at a glance", "access": "Your access",
    "models": "Model assignments", "config": "Policy settings",
}
_SUMMARIES = {
    "overview": "Read the deployment overview",
    "access": "Read your access",
    "models": "Read the model assignments",
    "config": "Read the policy settings",
}
_CONSOLE_FOR_KIND = {
    "overview": ("page:sources", "settings:models", "settings:demo"),
    "access": ("settings:roles", "settings:admin_users"),
    "models": ("settings:models", "page:models", "settings:keys"),
    "config": ("settings:advanced", "settings:detection.detection-autoclose", "page:cost"),
}


# --------------------------------------------------------------------------- #
# Builders: (trusted facts, operator values, kpi items).
# --------------------------------------------------------------------------- #
def _version(ctx: ChatToolContext) -> str:
    from ... import __version__

    return ctx.app_version or __version__


def _secrets_status(ctx: ChatToolContext) -> dict[str, bool] | None:
    """Configured booleans when the context exposes them (``secrets_status``)."""
    probe = getattr(ctx, "secrets_status", None)
    if not callable(probe):
        return None
    try:
        raw = probe()
    except Exception:  # noqa: BLE001 - a broken probe reports nothing, never a value
        return None
    if not isinstance(raw, dict):
        return None
    return {k: v for k, v in raw.items() if isinstance(k, str) and isinstance(v, bool)}


def _enabled(prefs: Any, name: str) -> bool:
    section = getattr(prefs, name, None)
    return bool(getattr(section, "enabled", False))


def _overview(ctx: ChatToolContext) -> tuple[dict[str, Any], dict[str, Any], list[dict[str, Any]]]:
    prefs = ctx.prefs
    version = _version(ctx)
    available, reason = app_knowledge_status()
    try:
        line = docs_line_for(version)
    except Exception:  # noqa: BLE001
        line = None
    auto_close = getattr(prefs, "auto_close", None)
    sources = list(getattr(prefs, "sources", None) or [])
    enabled_sources = [s for s in sources if getattr(s, "enabled", False)]
    pull = sum(1 for s in enabled_sources if str(getattr(getattr(s, "ingest_mode", ""), "value", getattr(s, "ingest_mode", ""))) == "pull")
    facts: dict[str, Any] = {
        "product": {"name": "Agentic SOC", "version": version, "help_center_line": line,
                    "help_center_available": available},
        "mode": {"demo_mode": bool(ctx.demo_active), "read_only_chat": True,
                 "settings_locked": bool(getattr(prefs, "read_only_settings_mode", False))},
        "capabilities": {
            "background_scan": bool(getattr(prefs, "background_scan_enabled", False)),
            "polling": bool(getattr(prefs, "polling_enabled", False)),
            "false_positive_auto_close": bool(getattr(getattr(auto_close, "false_positive", None), "enabled", False)),
            "true_positive_auto_close": bool(getattr(getattr(auto_close, "true_positive", None), "enabled", False)),
            "budget_gate": _enabled(prefs, "budget"),
            "kill_switch": bool(getattr(getattr(prefs, "caps", None), "kill_switch", False)),
            "knowledge_retrieval": _enabled(prefs, "rag"),
            "enrichment": _enabled(prefs, "enrichment"),
            "threat_context": _enabled(prefs, "threat_context"),
            "threshold_tuning": _enabled(prefs, "threshold_tuning"),
            "campaigns": _enabled(prefs, "campaign"),
            "baselines": _enabled(prefs, "baseline"),
            "realtime_updates": _enabled(prefs, "realtime"),
            "notifications": _enabled(prefs, "notifications"),
            "single_sign_on": _enabled(prefs, "sso"),
            "rbac": _enabled(prefs, "rbac"),
            "llm_batch": _enabled(prefs, "batch"),
            "chat_typed_answers": bool(getattr(getattr(prefs, "chat_agent", None), "allow_text_streaming", True)),
        },
        "sources": {"configured": len(sources), "enabled": len(enabled_sources), "enabled_pull": pull,
                    "enabled_push": len(enabled_sources) - pull},
    }
    if not available:
        facts["product"]["help_center_unavailable_reason"] = reason
    status = _secrets_status(ctx)
    if status is not None:
        facts["credentials_configured"] = {
            group: {key.removesuffix("_api_key"): status[key] for key in keys if key in status}
            for group, keys in _KEY_GROUPS.items()
        }
    operator_values: dict[str, Any] = {}
    org = getattr(getattr(prefs, "branding", None), "org_name", None)
    if isinstance(org, str) and org.strip():
        operator_values["organization_name"] = org.strip()[:120]
    names = [
        str(getattr(s, "display_name", "") or getattr(s, "id", ""))[:80]
        for s in sources[:_MAX_SOURCE_NAMES]
    ]
    if names:
        operator_values["source_names"] = names
    kpis = [
        {"key": "sources_enabled", "label": "Enabled sources", "value": len(enabled_sources), "unit": "count"},
        {"key": "sources_configured", "label": "Configured sources", "value": len(sources), "unit": "count"},
    ]
    budget = getattr(prefs, "budget", None)
    daily = getattr(budget, "daily_usd", None) if budget is not None and getattr(budget, "enabled", False) else None
    if isinstance(daily, (int, float)):
        kpis.append({"key": "daily_budget", "label": "Daily AI budget", "value": float(daily), "unit": "usd"})
    return facts, operator_values, kpis


def _access(ctx: ChatToolContext) -> tuple[dict[str, Any], dict[str, Any], list[dict[str, Any]]]:
    held = frozenset(ctx.grants)
    usable: list[str] = []
    locked: dict[str, str] = {}
    try:
        # Lazy: the registry discovers THIS module, so a module-level import would cycle.
        from .registry import catalogue

        tools = catalogue()
    except Exception:  # noqa: BLE001 - the grants below still answer the question
        tools = ()
    for tool in tools:
        missing = tool.missing_grants(held)
        if missing:
            locked[tool.name] = " or ".join(missing) if tool.kind_gated() else ", ".join(missing)
        else:
            usable.append(tool.name)
    # Grouped by the grant that would unlock them, so every missing grant is named even
    # when one of them gates many pages.
    locked_areas: dict[str, list[str]] = {}
    try:
        knowledge = get_app_knowledge()
        for target in knowledge.targets.values():
            if target.kind == "settings_card" or target.grant is None or target.grant in held:
                continue
            areas = locked_areas.setdefault(target.requires or "", [])
            if len(areas) < _MAX_AREAS_PER_GRANT:
                areas.append(target.breadcrumb)
    except Exception:  # noqa: BLE001 - access facts do not depend on the corpus
        pass
    facts: dict[str, Any] = {
        "your_permissions": sorted(f"{r}:{a}" for r, a in held),
        "chat_lookups_you_can_use": usable,
        "chat_lookups_locked": locked,
        "console_areas_needing_a_grant": locked_areas,
    }
    kpis = [
        {"key": "tools_usable", "label": "Lookups you can use", "value": len(usable), "unit": "count"},
        {"key": "tools_locked", "label": "Lookups locked", "value": len(locked), "unit": "count"},
    ]
    return facts, {}, kpis


def _models(ctx: ChatToolContext) -> tuple[dict[str, Any], dict[str, Any], list[dict[str, Any]]]:
    prefs = ctx.prefs
    status = _secrets_status(ctx)
    roles: dict[str, Any] = {}
    model_ids: dict[str, str] = {}
    for role, field_name in _ROLE_FIELDS:
        config = getattr(prefs, field_name, None)
        if config is None:
            continue
        provider = str(getattr(config, "provider", "") or "unknown")
        entry: dict[str, Any] = {"provider": provider[:40]}
        if provider in _KEY_OPTIONAL:
            entry["provider_key_required"] = False
        if status is not None:
            entry.update(_provider_key_facts(provider, status))
        roles[role] = entry
        model = getattr(config, "model", None)
        if isinstance(model, str) and model:
            model_ids[role] = model[:120]
    facts = {"roles": roles, "demo_mode_uses_simulated_models": bool(ctx.demo_active)}
    kpis = [{"key": "roles_assigned", "label": "Roles with a model", "value": len(model_ids), "unit": "count"}]
    return facts, ({"model_per_role": model_ids} if model_ids else {}), kpis


def _provider_key_facts(provider: str, status: dict[str, bool]) -> dict[str, Any]:
    """``provider_key_configured`` (some alternative fully set) plus, for a provider
    that needs several keys or accepts a fallback, the per-key booleans behind it.
    Nothing is reported when the probe lacks every key the provider uses."""
    alternatives = _PROVIDER_KEYS.get(provider)
    if not alternatives:
        return {}
    keys = list(dict.fromkeys(key for alternative in alternatives for key in alternative))
    if not any(key in status for key in keys):
        return {}
    facts: dict[str, Any] = {
        "provider_key_configured": any(all(status.get(key) is True for key in alt) for alt in alternatives),
    }
    if len(keys) > 1:
        facts["provider_keys"] = {key: status.get(key) is True for key in keys}
    return facts


def _config(ctx: ChatToolContext) -> tuple[dict[str, Any], dict[str, Any], list[dict[str, Any]]]:
    prefs = ctx.prefs
    budget = getattr(prefs, "budget", None)
    auto_close = getattr(prefs, "auto_close", None)
    chat = getattr(prefs, "chat_agent", None)

    def policy(entry: Any) -> dict[str, Any]:
        return {
            "enabled": bool(getattr(entry, "enabled", False)),
            "min_confidence": getattr(entry, "min_confidence", None),
            "max_risk_score": getattr(entry, "max_risk_score", None),
            "objection_window_minutes": getattr(entry, "objection_window_minutes", None),
        }

    facts: dict[str, Any] = {
        "budget": {
            "enabled": bool(getattr(budget, "enabled", False)),
            "daily_usd": getattr(budget, "daily_usd", None),
            "monthly_usd": getattr(budget, "monthly_usd", None),
            "warn_at_percent": round(float(getattr(budget, "soft_warn_pct", 0.0) or 0.0) * 100),
            "on_exceed": str(getattr(budget, "on_exceed", "")),
        },
        "auto_close_false_positive": policy(getattr(auto_close, "false_positive", None)),
        "auto_close_true_positive": policy(getattr(auto_close, "true_positive", None)),
        "auto_close_needs_human": "never (enforced in code)",
        "autopilot": {
            "profile": str(getattr(prefs, "autopilot_profile", "")),
            "auto_investigate_risk_floor": getattr(prefs, "auto_investigate_risk_floor", None),
            "max_auto_investigations_per_tick": getattr(getattr(prefs, "caps", None), "max_auto_investigations_per_tick", None),
        },
        "polling": {
            "enabled": bool(getattr(prefs, "polling_enabled", False)),
            "interval_seconds": getattr(prefs, "poll_interval_seconds", None),
            "batch_size": getattr(prefs, "poll_batch_size", None),
        },
        "chat_bounds": {
            name: getattr(chat, name, None)
            for name in ("max_model_calls", "max_tool_calls", "max_parallel", "turn_timeout_s",
                         "turn_token_ceiling", "max_concurrent_turns_per_user")
        },
    }
    kpis: list[dict[str, Any]] = []
    daily = facts["budget"]["daily_usd"]
    if facts["budget"]["enabled"] and isinstance(daily, (int, float)):
        kpis.append({"key": "daily_budget", "label": "Daily AI budget", "value": float(daily), "unit": "usd"})
    floor = facts["autopilot"]["auto_investigate_risk_floor"]
    if isinstance(floor, (int, float)):
        kpis.append({"key": "risk_floor", "label": "Auto-investigate risk floor", "value": floor, "unit": "score"})
    return facts, {}, kpis


def _console_links(ctx: ChatToolContext, kind: str) -> list[Any]:
    try:
        knowledge = get_app_knowledge()
    except Exception:  # noqa: BLE001 - no corpus, no console allowlist
        return []
    held = frozenset(ctx.grants)
    return [
        console_link(knowledge.targets[target_id], held)
        for target_id in _CONSOLE_FOR_KIND.get(kind, ())
        if target_id in knowledge.targets
    ]
