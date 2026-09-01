"""Token price table (USD per 1,000,000 tokens) + the bundled model registry.

Prices are approximate public list prices and are intentionally easy to edit —
the cost ledger's accuracy depends only on this one table. Unknown models fall
back to a conservative default so a call's cost is never silently zero.

Round-3 Feature-9 layered the richer ``model_registry.json`` catalog (context
window, modalities, capabilities, per-million costs, optional OpenAI-compatible
``base_url``) ON TOP of this table — but every legacy entry point
(``cost_for``/``provider_for``/``models_by_provider``/``pricing_source``) keeps the
in-code ``PRICES`` + tier heuristic as the FINAL fallback, so the catalog is purely
additive and back-compatible. Pricing precedence at call time (applied by the
gateway): operator PriceOverlayStore override → model_registry.json row →
``PRICES`` exact → tier heuristic → conservative default.
"""

from __future__ import annotations

import json
import logging
from functools import lru_cache
from pathlib import Path
from typing import Any

logger = logging.getLogger("tlsoc.llm.pricing")

# model -> (input_usd_per_million, output_usd_per_million)
PRICES: dict[str, tuple[float, float]] = {
    # --- Anthropic (authoritative per-MTok in/out; see model_registry.json) ---
    "claude-fable-5": (10.0, 50.0),
    "claude-opus-4-8": (5.0, 25.0),
    "claude-opus-4-7": (5.0, 25.0),
    "claude-sonnet-4-6": (3.0, 15.0),
    "claude-haiku-4-5": (1.0, 5.0),
    "claude-haiku-4-5-20251001": (1.0, 5.0),
    # --- OpenAI ---
    "gpt-4o": (2.5, 10.0),
    "gpt-4o-mini": (0.15, 0.60),
    # operator-verifiable approximate USD/1M tokens — edit in pricing.py and rebuild
    "gpt-4.1": (2.0, 8.0),
    "gpt-4.1-mini": (0.40, 1.60),
    "gpt-4-turbo": (10.0, 30.0),
    "gpt-4": (30.0, 60.0),
    "o4-mini": (1.10, 4.40),
    # Current official short-context Standard rate (2026-07-31). Long-context
    # requests have a separate tariff; Agentic SOC's bounded role prompts remain
    # comfortably below that threshold.
    "gpt-5.6-luna": (0.20, 1.20),
    "gpt-5": (1.25, 10.0),
    "gpt-5-mini": (0.25, 2.0),
    # --- Embeddings (input only) ---
    "text-embedding-3-small": (0.02, 0.0),
    "text-embedding-3-large": (0.13, 0.0),
    # --- Mock provider is free ---
    "mock": (0.0, 0.0),
}

_DEFAULT_PRICE = (1.0, 3.0)

# Tier-prefix heuristic (ported from Vigil's model_registry): when a NEW model
# variant appears that isn't in PRICES yet, give it a reasonable price from its
# family prefix instead of the flat default — and tag the cost as "heuristic" so
# the ledger/UI can distinguish an estimate from a verified rate. Checked in order;
# first prefix match wins.
_TIER_HEURISTIC: tuple[tuple[str, tuple[float, float]], ...] = (
    ("claude-fable", (10.0, 50.0)),
    ("claude-opus", (5.0, 25.0)),
    ("claude-sonnet", (3.0, 15.0)),
    ("claude-haiku", (1.0, 5.0)),
    ("gpt-5.6-luna", (0.20, 1.20)),
    ("gpt-5-mini", (0.25, 2.0)),
    ("gpt-5", (1.25, 10.0)),
    ("gpt-4o-mini", (0.15, 0.60)),
    ("gpt-4o", (2.5, 10.0)),
    ("gpt-4.1-mini", (0.40, 1.60)),
    ("gpt-4.1", (2.0, 8.0)),
    ("o4-mini", (1.10, 4.40)),
    ("text-embedding-3-large", (0.13, 0.0)),
    ("text-embedding-3", (0.02, 0.0)),
    ("text-embedding", (0.02, 0.0)),
)


def _heuristic_price(model: str) -> tuple[float, float] | None:
    for prefix, price in _TIER_HEURISTIC:
        if model.startswith(prefix):
            return price
    return None


# --------------------------------------------------------------------------- #
# Bundled model registry (Feature 9) — richer catalog metadata layered on top of
# PRICES. Loaded once from model_registry.json (data corpus, not a live fetch). All
# accessors degrade to {} on a load/parse failure so the in-code PRICES table always
# stands (the ledger never silently loses its price source).
# --------------------------------------------------------------------------- #
_REGISTRY_PATH = Path(__file__).with_name("model_registry.json")


@lru_cache(maxsize=1)
def load_registry() -> dict[str, dict[str, Any]]:
    """The ``{model_id: {provider, context_window, ..., input/output_per_million,
    base_url?}}`` catalog from ``model_registry.json``. Cached. Returns ``{}`` (never
    raises) on any read/parse error, so callers fall back to the in-code table."""
    try:
        raw = json.loads(_REGISTRY_PATH.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001 — registry is best-effort; PRICES stands
        logger.warning("model_registry.json load failed (%s); using PRICES only", exc)
        return {}
    models = raw.get("models", {}) if isinstance(raw, dict) else {}
    out: dict[str, dict[str, Any]] = {}
    for mid, meta in (models or {}).items():
        if isinstance(meta, dict):
            out[str(mid)] = dict(meta)
    return out


def registry_entry(model: str) -> dict[str, Any] | None:
    """The registry row for ``model`` (exact id match), or None."""
    return load_registry().get((model or "").strip()) or None


def model_capabilities(model: str) -> list[str]:
    """Declared capabilities for a bundled model id.

    Unknown models deliberately return an empty list: a role picker must not infer
    embedding support from pricing or a provider name. Runtime-registered custom
    models carry their own capability row at the API boundary.
    """
    entry = registry_entry(model)
    if not entry:
        return []
    return sorted({str(item) for item in (entry.get("capabilities") or []) if str(item)})


def model_supports_capability(model: str, capability: str) -> bool:
    """Whether the bundled registry explicitly declares ``capability``."""
    return str(capability) in model_capabilities(model)


# --------------------------------------------------------------------------- #
# Capability EVIDENCE, not a capability allowlist.
# --------------------------------------------------------------------------- #
# ``model_supports_capability`` answers one question — "does the bundled catalog
# declare this?" — and a boolean cannot carry the answer a configuration gate needs,
# because it collapses two completely different states into ``False``:
#
#   * the catalog KNOWS this model and does not list the capability (evidence of
#     incapability — a completion model in the embedding slot), and
#   * the catalog has never heard of this model (no evidence at all — every
#     self-hosted / LiteLLM / vLLM / Ollama / aggregator embedding model ever
#     registered at runtime, and every model released after this build).
#
# Treating the second as the first makes a bundled 23-row JSON file the authority on
# what a vendor-agnostic product may embed with, and the file declares the capability
# for exactly three ids. That is not a guard: a deployment's real embedding endpoint
# is unconfigurable while an unknown completion id sails through whichever gate reads
# the boolean the other way round. The portable answer is an EMPIRICAL PROBE (see
# ``api/routes_models.probe_embedding_model``); these helpers only report what the
# catalog can and cannot speak for, so a caller can tell a refusal backed by evidence
# from one backed by ignorance.
CAPABILITY_DECLARED = "declared"
CAPABILITY_DECLARED_ABSENT = "declared_absent"
CAPABILITY_UNKNOWN = "unknown"

EMBEDDING_CAPABILITY = "embedding"


def capability_state(model: str, capability: str) -> str:
    """What the bundled catalog can say about ``model`` and ``capability``.

    One of :data:`CAPABILITY_DECLARED` (the row lists it),
    :data:`CAPABILITY_DECLARED_ABSENT` (a row exists and does NOT list it — the only
    catalog-backed evidence of incapability), or :data:`CAPABILITY_UNKNOWN` (no row:
    a runtime-registered, self-hosted or newer model the bundled file predates).
    """
    entry = registry_entry(model)
    if not entry:
        return CAPABILITY_UNKNOWN
    if str(capability) in model_capabilities(model):
        return CAPABILITY_DECLARED
    return CAPABILITY_DECLARED_ABSENT


def model_may_embed(model: str) -> bool:
    """Whether ``model`` may be ACCEPTED into an embedding slot on catalog evidence.

    False only on positive evidence of incapability — a catalog row that declares
    other capabilities and not ``embedding``. An unknown id returns True because the
    bundled catalog holds no evidence either way; it is the empirical probe, not this
    lookup, that decides such a model. Refusing the unknown case here is what makes
    every self-hosted embedding endpoint unconfigurable on a vendor-agnostic product.
    """
    return capability_state(model, EMBEDDING_CAPABILITY) != CAPABILITY_DECLARED_ABSENT


def capability_coverage(capability: str = EMBEDDING_CAPABILITY) -> dict[str, int]:
    """How much of the bundled catalog a capability allowlist could speak for.

    ``{"catalog_models": N, "declaring_models": K}``. Published beside a probe result
    so an operator can see the size of the population the declaration covers rather
    than reading a catalog silence as a verdict.
    """
    registry = load_registry()
    declaring = sum(
        1
        for mid in registry
        if str(capability) in model_capabilities(mid)
    )
    return {"catalog_models": len(registry), "declaring_models": declaring}


def registry_price(model: str) -> tuple[float, float] | None:
    """``(input_per_million, output_per_million)`` from the registry row, or None when
    the model is unknown to the registry (→ caller falls back to PRICES / heuristic)."""
    entry = registry_entry(model)
    if not entry:
        return None
    try:
        return (float(entry.get("input_per_million", 0.0) or 0.0),
                float(entry.get("output_per_million", 0.0) or 0.0))
    except (TypeError, ValueError):
        return None


def cache_rates(model: str, input_rate: float) -> tuple[float, float, float]:
    """The per-1M ``(cache_read_rate, cache_write_5m_rate, cache_write_1h_rate)`` for
    ``model``, in USD/1M tokens.

    Prompt-caching billing (Anthropic + OpenAI): a cache READ is ``0.1×`` the input
    rate; a 5-minute cache WRITE is ``1.25×`` input; a 1-hour cache WRITE is ``2.0×``
    input. When the bundled registry declares an explicit ``cache_read_per_million`` /
    ``cache_write_per_million`` we honour it (the write field being the 5-minute rate);
    the 1-hour write is always derived as ``2.0×`` the input rate (registries carry only
    the default 5-minute write). Absent a registry row we fall back to the standard
    ``0.1× / 1.25× / 2.0×`` of the resolved input rate — so an operator never has to
    hand-fill the cache columns for the multiplier to apply."""
    read_default = 0.1 * input_rate
    write_5m_default = 1.25 * input_rate
    write_1h = 2.0 * input_rate
    entry = registry_entry(model)
    if not entry:
        return (read_default, write_5m_default, write_1h)
    try:
        cr = entry.get("cache_read_per_million")
        cw = entry.get("cache_write_per_million")
        read_rate = float(cr) if cr is not None else read_default
        write_5m = float(cw) if cw is not None else write_5m_default
    except (TypeError, ValueError):
        return (read_default, write_5m_default, write_1h)
    return (read_rate, write_5m, write_1h)


def base_url_for(model: str) -> str | None:
    """The optional OpenAI-compatible ``base_url`` for ``model`` from the registry —
    lets a self-hosted/aggregator endpoint (vLLM/Ollama/OpenRouter/Together/Groq) be
    addressed by model id when the per-role ModelConfig cannot carry one. None when
    unset (→ the provider's default endpoint)."""
    entry = registry_entry(model)
    if not entry:
        return None
    url = str(entry.get("base_url", "") or "").strip()
    return url or None


def model_catalog() -> list[dict[str, Any]]:
    """The full registry as a sorted list of rows, each enriched with its resolved
    provider + ``pricing_source`` provenance, for the ``GET /api/llm/models`` surface.
    A model present in PRICES but absent from the registry is synthesised from its
    price tuple so the catalog never drops a priced model."""
    reg = load_registry()
    rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    for mid, meta in reg.items():
        in_p, out_p = registry_price(mid) or PRICES.get(mid) or _DEFAULT_PRICE
        rows.append({
            "id": mid,
            "label": meta.get("label", mid),
            "provider": str(meta.get("provider") or provider_for(mid)),
            "context_window": int(meta.get("context_window", 0) or 0),
            "max_output": int(meta.get("max_output", 0) or 0),
            "modalities": list(meta.get("modalities", []) or []),
            "capabilities": list(meta.get("capabilities", []) or []),
            "input_per_million": in_p,
            "output_per_million": out_p,
            "cache_write_per_million": meta.get("cache_write_per_million"),
            "cache_read_per_million": meta.get("cache_read_per_million"),
            "batch_multiplier": 0.5,
            "base_url": base_url_for(mid),
            "pricing_source": pricing_source(mid),
        })
        seen.add(mid)
    for mid in PRICES:
        if mid in seen:
            continue
        in_p, out_p = PRICES[mid]
        rows.append({
            "id": mid, "label": mid, "provider": provider_for(mid),
            "context_window": 0, "max_output": 0, "modalities": [], "capabilities": [],
            "input_per_million": in_p, "output_per_million": out_p,
            "cache_write_per_million": None, "cache_read_per_million": None,
            "batch_multiplier": 0.5,
            "base_url": None, "pricing_source": pricing_source(mid),
        })
    rows.sort(key=lambda r: (r["provider"], r["id"]))
    return rows


def pricing_source(model: str) -> str:
    """Provenance of the rate used to price ``model`` (ported from Vigil): one of
    ``exact`` (a verified row in PRICES OR the bundled registry), ``heuristic``
    (priced from a family prefix), ``zero`` (the free mock provider), or ``default``
    (the conservative fallback). Threaded onto every ``UsageDoc`` so the cost surface
    can badge an approximate cost vs a verified one, and a real $0 vs a missing rate."""
    if model.startswith("mock"):
        return "zero"
    if model in PRICES:
        return "exact"
    if registry_price(model) is not None:
        return "exact"
    if _heuristic_price(model) is not None:
        return "heuristic"
    return "default"


def provider_for(model: str) -> str:
    """Group a price-table model id by its provider (Feature 4).

    ``claude-*`` -> anthropic; ``gpt-*`` / ``o1``/``o3``/``o4``-series /
    ``text-embedding-*`` -> openai; ``mock`` -> mock. Anything unrecognised is
    bucketed under ``other`` so a new model never disappears from the catalog.

    A model that the bundled registry declares an explicit ``provider`` for wins over
    the prefix heuristic — but ONLY when the prefix rules would otherwise return
    ``other`` (a registry-declared azure/bedrock/vertex/openai_compatible model), so
    the existing anthropic/openai/mock prefix mapping stays byte-identical."""
    if model.startswith("claude-"):
        return "anthropic"
    if (
        model.startswith("gpt-")
        or model.startswith("text-embedding-")
        or model.startswith(("o1", "o3", "o4"))
    ):
        return "openai"
    if model.startswith("mock"):
        return "mock"
    entry = registry_entry(model)
    if entry:
        declared = str(entry.get("provider", "") or "").strip()
        if declared:
            return declared
    return "other"


def models_by_provider() -> dict[str, list[str]]:
    """The known models grouped by provider, each list sorted (Feature 4).

    Unions the in-code ``PRICES`` table with the bundled ``model_registry.json`` so a
    registry-only model (e.g. an azure/bedrock/vertex/openai_compatible id) still
    appears in the settings per-role picker. The three legacy buckets (anthropic /
    openai / mock) are always present so existing callers see no shape change."""
    grouped: dict[str, list[str]] = {"anthropic": [], "openai": [], "mock": []}
    for model in set(PRICES) | set(load_registry()):
        grouped.setdefault(provider_for(model), []).append(model)
    return {provider: sorted(set(models)) for provider, models in grouped.items()}


def resolve_price(model: str, overlay: tuple[float, float] | None = None) -> tuple[float, float]:
    """The effective ``(input_per_million, output_per_million)`` for ``model``, in
    precedence order: an operator PriceOverlayStore ``overlay`` tuple → the in-code
    ``PRICES`` exact row → the bundled registry row → the tier heuristic → the
    conservative default. The mock provider is free.

    ``PRICES`` is checked BEFORE the registry so an operator who edits ``pricing.py``
    still wins over the bundled catalog (back-compat for the existing edit-the-table
    workflow); the registry only fills models the table doesn't know."""
    if model.startswith("mock"):
        return (0.0, 0.0)
    if overlay is not None:
        return overlay
    return PRICES.get(model) or registry_price(model) or _heuristic_price(model) or _DEFAULT_PRICE


def cost_for(model: str, prompt_tokens: int, completion_tokens: int,
             overlay: tuple[float, float] | None = None,
             *,
             cache_read_tokens: int = 0,
             cache_write_tokens: int = 0,
             cache_write_ttl: str = "5m",
             batch: bool = False) -> float:
    """The metered cost of ONE call, USD, rounded ONCE at the end (8 dp).

    Non-cache, non-batch calls (``cache_read_tokens == cache_write_tokens == 0`` and
    ``batch is False``) are BYTE-IDENTICAL to the historical two-term formula
    ``round((prompt/1e6)*in + (completion/1e6)*out, 8)`` — the cache/batch dimensions
    are keyword-only, defaulted, additive extensions (contract §5.1/§5.2).

    Prompt-cache billing: cache-READ tokens bill at ``0.1×`` input, cache-WRITE tokens
    at ``1.25×`` input for a 5-minute TTL or ``2.0×`` input for a 1-hour TTL (or the
    registry's declared per-1M cache rates). ``batch=True`` (a provider async batch API
    call) halves the WHOLE cost (``0.5×``). Everything is summed in per-1M units and
    rounded once."""
    if model.startswith("mock"):
        return 0.0
    in_price, out_price = resolve_price(model, overlay)
    total = (
        (prompt_tokens / 1_000_000.0) * in_price
        + (completion_tokens / 1_000_000.0) * out_price
    )
    if cache_read_tokens or cache_write_tokens:
        read_rate, write_5m, write_1h = cache_rates(model, in_price)
        write_rate = write_1h if str(cache_write_ttl) == "1h" else write_5m
        total += (
            (cache_read_tokens / 1_000_000.0) * read_rate
            + (cache_write_tokens / 1_000_000.0) * write_rate
        )
    if batch:
        total *= 0.5
    return round(total, 8)
