"""Models / LLMs + cost-governance routes (Round 3, Feature 9).

A SEPARATE router module (the integrator mounts it with the same ``require_auth``
mount the monolith uses). It exposes:

* ``GET  /api/llm/models``            — the bundled model catalog enriched with
                                        capabilities / pricing / provenance + the
                                        per-role assignment from Preferences.
* ``GET  /api/llm/providers``         — the provider registry + configured-booleans.
* ``POST /api/llm/models/test``       — route a tiny prompt through the ONE gateway
                                        (still hits the ledger #6) to verify a model.
                                        ``mode="embedding"`` runs the EMPIRICAL
                                        embedding probe instead, so a self-hosted
                                        embedding endpoint can be validated BEFORE it
                                        is saved into the embedding role.
* ``PUT  /api/llm/models/{id}/pricing`` — set an operator price override
                                        (PriceOverlayStore; layered on the ledger).
* ``POST /api/cost/estimate``         — a pre-flight USD estimate for a prompt+budget.
* ``GET/PUT /api/budget``             — read / update the cost-budget ceiling config.
* ``GET  /api/budget/status``         — the live rolling spend vs the ceilings.

Every model id / error string returned to the client is treated as plain,
attacker-influenceable data (#9): we fence model/error text before it could reach a
prompt, and the values returned here are PLAIN (the UI renders them escaped). These
routes NEVER touch ``case_manager.decide()`` (#3); a budget block only governs
whether an LLM call RUNS — enforced in the gateway, which fails to NEEDS_HUMAN.
"""

from __future__ import annotations

import logging
import math
from typing import Any
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from ..config import BudgetConfig, ModelConfig
from ..llm.pricing import (
    EMBEDDING_CAPABILITY,
    base_url_for,
    capability_coverage,
    capability_state,
    model_catalog,
    models_by_provider,
    pricing_source,
    registry_entry,
)
from ..llm.providers import classify_http_error
from ..state import AppState
from .deps import current_username, get_state, require_permission

logger = logging.getLogger("tlsoc.api.models")

router = APIRouter(prefix="/api")

# The roles that map to a ModelConfig field on Preferences (mirrors model_for()).
_ROLE_FIELDS = (
    "router", "investigator", "formatter", "standup", "chat", "overview", "embedding",
)


def _safe(value: Any) -> str:
    """Return ``value`` as a plain, length-bounded string for the client (#9): the UI
    renders it escaped and we never feed it back into a prompt. Bounds runaway error
    bodies so a hostile upstream can't blow up the response."""
    return str(value)[:2000]


def _assigned_roles(prefs) -> dict[str, list[str]]:
    """model id -> the per-role slots it is assigned to in Preferences, so the catalog
    can show "investigator, chat" next to a model. Read-only over the config."""
    out: dict[str, list[str]] = {}
    for role in _ROLE_FIELDS:
        cfg = getattr(prefs, f"{role}_model", None)
        mid = getattr(cfg, "model", None)
        if mid:
            out.setdefault(str(mid), []).append(role)
    return out


async def _custom_catalog_rows(state: AppState, seen: set[str]) -> list[dict[str, Any]]:
    """Catalog rows for the operator's runtime-registered self-hosted / LiteLLM models,
    shaped like ``model_catalog()`` rows (so the merge is uniform) and tagged
    ``is_custom``. A local model is FREE ($0) with 'exact' provenance. Best-effort — a
    store glitch returns [] so the built-in catalog always stands."""
    rows: list[dict[str, Any]] = []
    try:
        registered = await state.custom_models.list_models()
    except Exception as exc:  # noqa: BLE001 — custom store is advisory to the catalog
        logger.warning("custom model list failed (%s); catalog shows built-ins only", exc)
        return rows
    for c in registered:
        cid = str(c.get("id", ""))
        if not cid or cid in seen:
            continue
        seen.add(cid)
        rows.append({
            "id": cid,
            "label": _safe(c.get("label") or cid),
            "provider": str(c.get("provider") or "openai_compatible"),
            "context_window": int(c.get("context_window", 0) or 0),
            "max_output": 0,
            "modalities": [],
            "capabilities": ["chat"],
            "input_per_million": float(c.get("input_per_million", 0.0) or 0.0),
            "output_per_million": float(c.get("output_per_million", 0.0) or 0.0),
            "cache_write_per_million": None,
            "cache_read_per_million": None,
            "batch_multiplier": 0.5,
            "base_url": _safe(c.get("base_url") or "") or None,
            "pricing_source": "exact",   # operator-supplied local model → real $0
            "is_custom": True,
        })
    return rows


# --------------------------------------------------------------------------- #
# GET /api/llm/models — catalog + capabilities + pricing + provenance + assignment
# --------------------------------------------------------------------------- #
@router.get("/llm/models")
async def llm_models(state: AppState = Depends(get_state)) -> dict[str, Any]:
    assigned = _assigned_roles(state.prefs)
    overlay: dict[str, dict[str, float]] = {}
    try:
        overlay = await state.price_overlay.get()
    except Exception as exc:  # noqa: BLE001 — overlay is advisory; catalog still lists rates
        logger.warning("price overlay read failed (%s); showing built-in rates", exc)
    # Merge the operator's runtime-registered self-hosted / LiteLLM (OpenAI-compatible)
    # models into the bundled catalog so a locally-added model shows up in the picker.
    # A local model is FREE ($0) with 'exact' provenance (operator-supplied), carries its
    # base_url, and is tagged is_custom so the UI can badge + offer Remove. Best-effort:
    # a store glitch never blanks the built-in catalog. (#9: ids/labels are fenced/plain.)
    base_rows = model_catalog()
    seen = {str(r["id"]) for r in base_rows}
    custom_rows = await _custom_catalog_rows(state, seen)
    models: list[dict[str, Any]] = []
    for row in base_rows + custom_rows:
        mid = row["id"]
        ov = overlay.get(mid)
        enriched = dict(row)
        enriched["id"] = _safe(mid)
        enriched["assigned_roles"] = assigned.get(mid, [])
        enriched["is_custom"] = bool(row.get("is_custom"))
        if ov:
            enriched["input_per_million"] = float(ov.get("input", 0.0))
            enriched["output_per_million"] = float(ov.get("output", 0.0))
            enriched["pricing_source"] = "exact"  # operator-supplied contract rate
            # A custom model's $0 overlay is a shipped default, not a hand-set override —
            # don't flag it as an operator override (avoids a misleading override marker).
            enriched["price_overridden"] = not enriched["is_custom"]
        else:
            enriched["price_overridden"] = False
        models.append(enriched)
    return {
        "models": models,
        "providers": models_by_provider(),
        "configured": state.secrets.configured_status(),
        "overrides": overlay,
    }


# --------------------------------------------------------------------------- #
# GET /api/llm/providers — the provider registry + per-provider configured flag
# --------------------------------------------------------------------------- #
@router.get("/llm/providers")
async def llm_providers(state: AppState = Depends(get_state)) -> dict[str, Any]:
    from ..llm.providers import PROVIDER_REGISTRY

    configured = state.secrets.configured_status()
    # A provider is "configured" when EVERY credential it needs is set — reading from
    # the boolean ``configured_status`` map so there is one source of truth. The
    # OpenAI-compatible/self-hosted path needs no key (base_url drives it).
    #   * azure needs a key (its own, or the OpenAI key as a convenience per
    #     config.provider_key) AND a resource endpoint — without the endpoint a call
    #     would resolve to a placeholder host and DNS-fail, so endpoint is required.
    #   * vertex's credential field is ``vertex_api_key`` (a short-lived OAuth token),
    #     NOT ``vertex_access_token`` — the old read was permanently False.
    provider_configured = {
        "anthropic": bool(configured.get("anthropic_api_key")),
        "openai": bool(configured.get("openai_api_key")),
        "mock": True,
        "azure": bool(
            (configured.get("azure_openai_api_key") or configured.get("openai_api_key"))
            and configured.get("azure_openai_endpoint")
        ),
        "bedrock": bool(configured.get("aws_access_key_id")),
        "vertex": bool(configured.get("vertex_api_key")),
        "openai_compatible": True,
    }
    grouped = models_by_provider()
    return {
        "providers": [
            {
                "name": name,
                "configured": provider_configured.get(name, False),
                "models": grouped.get(name, []),
                "supports_base_url": name in ("openai", "openai_compatible", "azure",
                                              "bedrock", "vertex"),
            }
            for name in PROVIDER_REGISTRY
        ],
    }


# --------------------------------------------------------------------------- #
# The EMPIRICAL embedding probe.
# --------------------------------------------------------------------------- #
# What would have caught a completion model in the embedding slot? Not a capability
# allowlist: the bundled catalog declares ``embedding`` for a handful of ids, so the
# allowlist rejects every self-hosted / LiteLLM / vLLM / Ollama endpoint an operator
# actually runs while saying nothing at all about an id it has never heard of. The
# portable answer is to ASK THE ENDPOINT and look at what comes back.
#
# The probe embeds a short fixed anchor, a short fixed contrast string, and the anchor
# AGAIN, then states only what any real embedding space must satisfy:
#
#   * the CONFIGURED provider actually answered (the gateway degrades to deterministic
#     local hash vectors on a provider failure — those vectors are numeric, stable and
#     discriminating, so without this check the probe would certify the fallback rather
#     than the model);
#   * the response is a vector of finite numbers, not prose, not a token stream;
#   * its dimensionality is STABLE across the three inputs and non-trivial;
#   * no vector is all-zero (cosine against it is undefined — the same guard the
#     corpus writer applies before it will persist a chunk); and
#   * the anchor is MORE similar to its own repeat than to the contrast string.
#
# That last one is deliberately an ORDERING statement, never an absolute cosine floor.
# Similarity magnitudes are a property of the embedding family — some families put
# unrelated English sentences at 0.85, others at 0.05 — so any fixed floor is a
# threshold tuned to whichever family the author had in front of them, and it will
# reject a perfectly good model from a different one. The ordering holds for every
# embedding space that encodes meaning at all, and fails for the two things this probe
# exists to catch: a constant/degenerate response, and a completion endpoint.
#
# Cost: three short strings through the ONE gateway, so the call is metered like any
# other (#6). No prompt path (#9): the probe strings are ours, and the model id /
# provider text returned is plain, bounded data.
_PROBE_ANCHOR = "authentication failed for an administrative account from a remote host"
_PROBE_CONTRAST = "the quarterly catering invoice was filed under office expenses"

#: A shape backstop, not a quality bar: real embedding families ship 128..3072
#: dimensions, and anything below a handful of components cannot carry a meaning
#: at all. It is deliberately far under every real family so it can never reject one.
_PROBE_MIN_DIM = 8


def _finite_floats(vector: Any) -> list[float] | None:
    """``vector`` as a list of finite floats, or None when it is not numeric.

    Booleans are rejected explicitly: ``bool`` is a subclass of ``int``, so a
    ``[True, False, ...]`` response would otherwise read as a numeric vector.
    """
    if not isinstance(vector, (list, tuple)) or not vector:
        return None
    out: list[float] = []
    for component in vector:
        if isinstance(component, bool) or not isinstance(component, (int, float)):
            return None
        value = float(component)
        if not math.isfinite(value):   # NaN / +-inf is not a usable component
            return None
        out.append(value)
    return out


def _cosine(left: list[float], right: list[float]) -> float | None:
    """Cosine similarity, or None when either vector has no magnitude."""
    if len(left) != len(right):
        return None
    dot = sum(a * b for a, b in zip(left, right))
    norm_left = sum(a * a for a in left) ** 0.5
    norm_right = sum(b * b for b in right) ** 0.5
    if norm_left <= 0.0 or norm_right <= 0.0:
        return None
    return dot / (norm_left * norm_right)


def _check(check_id: str, passed: bool, detail: str) -> dict[str, Any]:
    return {"id": check_id, "passed": bool(passed), "detail": detail}


async def probe_embedding_model(gateway: Any, cfg: ModelConfig) -> dict[str, Any]:
    """Empirically verify that ``cfg`` names a usable EMBEDDING model. Never raises.

    Returns ``{ok, checks, observed, message}``. ``ok`` is True only when every check
    passed; ``message`` always names what was OBSERVED (dimensionality, the two
    similarities, the provider that answered) rather than asserting a capability, so a
    refusal is arguable against evidence instead of against a bundled list.

    Portable by construction: every assertion is a property of an embedding response,
    not of a vendor, a model family or a price row, so an operator's own endpoint is
    judged on the same terms as a hosted one.
    """
    observed: dict[str, Any] = {
        "provider": "",
        "model": "",
        "fallback": False,
        "fallback_reason": "",
        "vectors_returned": 0,
        "dimensions": None,
        "dimensions_stable": None,
        "self_similarity": None,
        "contrast_similarity": None,
        "distinct_vectors": None,
    }
    texts = [_PROBE_ANCHOR, _PROBE_CONTRAST, _PROBE_ANCHOR]
    try:
        batch = await gateway.embed_with_provenance(texts, cfg, surface="embedding_probe")
    except Exception as exc:  # noqa: BLE001 — a provider/gateway failure IS the finding
        return {
            "ok": False,
            "checks": [_check("call_succeeded", False, _safe(exc))],
            "observed": observed,
            "message": (
                "the embedding call failed, so nothing was observed about this model: "
                f"{_safe(exc)}"
            ),
        }

    observed["provider"] = _safe(getattr(batch, "provider", "") or "")
    observed["model"] = _safe(getattr(batch, "model", "") or "")
    observed["fallback"] = bool(getattr(batch, "fallback", False))
    observed["fallback_reason"] = _safe(getattr(batch, "fallback_reason", "") or "")
    vectors_raw = list(getattr(batch, "vectors", None) or [])
    observed["vectors_returned"] = len(vectors_raw)

    checks: list[dict[str, Any]] = []

    # 1. The CONFIGURED provider answered. The gateway substitutes deterministic local
    #    hash vectors whenever it cannot reach the provider, and those satisfy every
    #    numeric check below — so without this the probe would happily certify a model
    #    whose endpoint rejected the request outright.
    if observed["fallback"]:
        reason = observed["fallback_reason"] or "the provider did not answer"
        checks.append(_check("configured_provider_answered", False, reason))
        return {
            "ok": False,
            "checks": checks,
            "observed": observed,
            "message": (
                "the configured embedding provider did not answer "
                f"({reason}), so the vectors observed came from the local fallback "
                "rather than from this model — nothing was learned about it"
            ),
        }
    checks.append(_check("configured_provider_answered", True,
                         f"answered by provider {observed['provider'] or 'unknown'}"))

    # 2. Three numeric vectors, one per input.
    vectors = [_finite_floats(vector) for vector in vectors_raw]
    if len(vectors) != len(texts) or any(vector is None for vector in vectors):
        checks.append(_check(
            "numeric_vector_response", False,
            f"expected {len(texts)} numeric vector(s), observed {len(vectors_raw)} "
            "response item(s), not all of which were finite numeric vectors",
        ))
        return {
            "ok": False,
            "checks": checks,
            "observed": observed,
            "message": (
                f"the endpoint returned {len(vectors_raw)} item(s) for {len(texts)} "
                "input(s) and they were not all finite numeric vectors, so this is not "
                "an embedding response"
            ),
        }
    anchor, contrast, anchor_repeat = vectors  # type: ignore[misc]
    checks.append(_check("numeric_vector_response", True,
                         f"{len(vectors)} finite numeric vector(s)"))

    # 3. Stable, non-trivial dimensionality.
    dims = {len(vector) for vector in vectors}
    observed["dimensions"] = min(dims) if len(dims) == 1 else sorted(dims)
    observed["dimensions_stable"] = len(dims) == 1
    checks.append(_check(
        "stable_dimensionality", len(dims) == 1,
        f"observed dimensionality {sorted(dims)}",
    ))
    non_trivial = len(dims) == 1 and min(dims) >= _PROBE_MIN_DIM
    checks.append(_check(
        "non_trivial_dimensionality", non_trivial,
        f"observed {sorted(dims)} against a minimum of {_PROBE_MIN_DIM}",
    ))

    # 4. No all-zero vector (cosine against one is undefined).
    non_zero = all(any(component != 0.0 for component in vector) for vector in vectors)
    checks.append(_check("non_zero_vectors", non_zero,
                         "every vector carries magnitude" if non_zero
                         else "at least one vector is all-zero"))

    # 5. Two different inputs must not produce one vector.
    distinct = anchor != contrast
    observed["distinct_vectors"] = bool(distinct)
    checks.append(_check(
        "distinct_inputs_distinct_vectors", distinct,
        "two different inputs produced different vectors" if distinct
        else "two different inputs produced an identical vector",
    ))

    # 6. The ORDERING statement — never an absolute similarity floor (see the note
    #    above this function). Skipped rather than faked when a magnitude is missing.
    self_similarity = _cosine(anchor, anchor_repeat)
    contrast_similarity = _cosine(anchor, contrast)
    observed["self_similarity"] = (
        round(self_similarity, 6) if self_similarity is not None else None
    )
    observed["contrast_similarity"] = (
        round(contrast_similarity, 6) if contrast_similarity is not None else None
    )
    if self_similarity is None or contrast_similarity is None:
        checks.append(_check(
            "discriminates_between_inputs", False,
            "similarity could not be computed (a vector had no magnitude or the "
            "dimensionality was unstable)",
        ))
    else:
        checks.append(_check(
            "discriminates_between_inputs", self_similarity > contrast_similarity,
            f"the same input scored {self_similarity:.6f} against itself and "
            f"{contrast_similarity:.6f} against a different input",
        ))

    ok = all(check["passed"] for check in checks)
    dim_text = (
        f"{observed['dimensions']}-dimensional"
        if isinstance(observed["dimensions"], int) else
        f"inconsistently {observed['dimensions']}-dimensional"
    )
    if ok:
        message = (
            f"observed {len(vectors)} {dim_text} vector(s) from provider "
            f"{observed['provider'] or 'unknown'}; the same input scored "
            f"{self_similarity:.6f} against itself and {contrast_similarity:.6f} "
            "against a different input, so this endpoint returns a usable embedding "
            "space"
        )
    else:
        failed = ", ".join(check["id"] for check in checks if not check["passed"])
        message = (
            f"observed {len(vectors)} {dim_text} vector(s) from provider "
            f"{observed['provider'] or 'unknown'}"
            + (
                f"; the same input scored {self_similarity:.6f} against itself and "
                f"{contrast_similarity:.6f} against a different input"
                if self_similarity is not None and contrast_similarity is not None
                else ""
            )
            + f" — this is not a usable embedding space ({failed})"
        )
    return {"ok": ok, "checks": checks, "observed": observed, "message": message}


# --------------------------------------------------------------------------- #
# POST /api/llm/models/test — verify a model THROUGH the one gateway (hits ledger)
# --------------------------------------------------------------------------- #
class ModelTestBody(BaseModel):
    model: str = Field(..., min_length=1, max_length=200)
    provider: str | None = None
    prompt: str = Field(default="Reply with the single word: ok", max_length=2000)
    #: ``chat`` (the default, byte-identical to the historical behaviour) sends the
    #: prompt as a completion. ``embedding`` runs the empirical embedding probe
    #: instead, so an operator can verify a model BEFORE assigning it to the
    #: embedding role rather than discovering the mistake as a silently degraded
    #: corpus. Additive: an existing client that omits the field is unaffected.
    mode: str = Field(default="chat", max_length=32)


@router.post("/llm/models/test")
async def llm_model_test(
    body: ModelTestBody,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("models", "manage")),
) -> dict[str, Any]:
    mid = body.model.strip()
    if not mid:
        raise HTTPException(status_code=400, detail="model is required")
    mode = (body.mode or "chat").strip().lower()
    if mode not in ("chat", "embedding"):
        raise HTTPException(status_code=400, detail="mode must be 'chat' or 'embedding'")
    # A runtime-registered self-hosted / LiteLLM model routes over the openai_compatible
    # provider at ITS base_url (checked first so a bare custom id doesn't resolve to the
    # heuristic "other" — which has no provider factory — and so the endpoint is carried
    # onto the ModelConfig even without the gateway's store fallback).
    custom_base_url: str | None = None
    try:
        custom_row = await state.custom_models.get_model(mid)
    except Exception:  # noqa: BLE001 — custom store advisory to the test
        custom_row = None
    # Resolve the provider: explicit override → custom model → registry-declared → prefix.
    if body.provider:
        provider = body.provider.strip()
    elif custom_row:
        provider = str(custom_row.get("provider") or "openai_compatible")
        custom_base_url = str(custom_row.get("base_url") or "") or None
    else:
        entry = registry_entry(mid) or {}
        from ..llm.pricing import provider_for

        provider = str(entry.get("provider") or provider_for(mid))
    try:
        # The Provider Literal now includes the cloud providers
        # (azure/bedrock/vertex/openai_compatible) alongside anthropic/openai/mock, so a
        # standard, validated construction covers them directly — no model_construct
        # bypass. A provider name outside the Literal (e.g. ``other`` from the heuristic,
        # or an out-of-tree registry provider) still validates leniently so the gateway's
        # PROVIDER_REGISTRY can attempt to dispatch it.
        cfg = ModelConfig(provider=provider, model=mid, max_tokens=16,  # type: ignore[arg-type]
                          base_url=custom_base_url)
    except Exception:  # noqa: BLE001 — a provider name outside the widened Literal
        cfg = ModelConfig.model_construct(
            provider=provider, model=mid, temperature=0.1, max_tokens=16,  # type: ignore[arg-type]
            base_url=custom_base_url,
        )
    if mode == "embedding":
        # The empirical probe. It replaces the question "does a bundled JSON file
        # declare this id embedding-capable?" — which cannot be answered for an
        # operator's own endpoint — with "what does this endpoint actually return?".
        # The catalog DECLARATION travels alongside as context, never as the verdict.
        probe = await probe_embedding_model(state.gateway, cfg)
        declaration = capability_state(mid, EMBEDDING_CAPABILITY)
        return {
            "ok": bool(probe["ok"]),
            "mode": "embedding",
            "model": _safe(probe["observed"].get("model") or mid),
            "provider": _safe(probe["observed"].get("provider") or provider),
            "checks": probe["checks"],
            "observed": probe["observed"],
            "message": _safe(probe["message"]),
            # Present so a UI can explain a surprising result, NOT so anything can
            # decide on it: ``unknown`` is the normal state for a self-hosted model and
            # must never read as a failure.
            "catalog_declaration": {
                "state": declaration,
                **capability_coverage(EMBEDDING_CAPABILITY),
            },
            "error": "" if probe["ok"] else _safe(probe["message"]),
            "pricing_source": pricing_source(
                str(probe["observed"].get("model") or mid)
            ),
            "base_url": cfg.base_url or base_url_for(mid),
        }
    messages = [{"role": "user", "content": str(body.prompt)[:2000]}]
    try:
        result = await state.gateway.complete(
            "chat", messages, cfg, surface="model_test",
        )
    except Exception as exc:  # noqa: BLE001 — a GatewayError or provider failure
        # Plain, bounded error text (#9). If the provider ran and failed, the gateway
        # already recorded one ERROR ledger row; a budget BLOCK raised before the call
        # and recorded nothing (zero rows). Either way no OK row is written here.
        return {"ok": False, "mode": "chat", "model": _safe(mid),
                "provider": _safe(provider), "error": _safe(exc)}
    # Badge the price the same way the ledger row this call wrote did (gateway._record)
    # and the sibling /cost/estimate endpoint: an active operator overlay → 'exact',
    # else the built-in table provenance. Without this the dialog could show
    # 'heuristic'/'default' while the ledger row for the same call shows 'exact'.
    eff_model = result.model or mid
    overlay = None
    try:
        overlay = await state.price_overlay.as_price_tuple(eff_model)
    except Exception:  # noqa: BLE001 — overlay advisory; fall back to the table
        overlay = None
    return {
        "ok": True,
        "mode": "chat",
        "model": _safe(eff_model),
        "provider": _safe(provider),
        "reply": _safe(result.text),
        "prompt_tokens": result.prompt_tokens,
        "completion_tokens": result.completion_tokens,
        "cost": result.cost,
        "pricing_source": "exact" if overlay is not None else pricing_source(eff_model),
        "base_url": base_url_for(mid),
    }


# --------------------------------------------------------------------------- #
# PUT /api/llm/models/{id}/pricing — operator per-model price override
# --------------------------------------------------------------------------- #
class PricingBody(BaseModel):
    input_per_million: float = Field(..., ge=0.0)
    output_per_million: float = Field(..., ge=0.0)


@router.put("/llm/models/{model_id}/pricing")
async def llm_model_pricing(
    model_id: str,
    body: PricingBody,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("models", "manage")),
) -> dict[str, Any]:
    mid = (model_id or "").strip()
    if not mid:
        raise HTTPException(status_code=400, detail="model id is required")
    try:
        row = await state.price_overlay.set_price(
            mid, body.input_per_million, body.output_per_million,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=_safe(exc)) from exc
    await _audit(state, request, "model_pricing_set",
                 f"override {mid} -> in=${row['input']}/1M out=${row['output']}/1M")
    return {"ok": True, "model": _safe(mid), "pricing": row, "pricing_source": "exact"}


@router.delete("/llm/models/{model_id}/pricing")
async def llm_model_pricing_delete(
    model_id: str,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("models", "manage")),
) -> dict[str, Any]:
    mid = (model_id or "").strip()
    removed = await state.price_overlay.delete(mid)
    if removed:
        await _audit(state, request, "model_pricing_clear", f"cleared override for {mid}")
    return {"ok": True, "model": _safe(mid), "removed": removed,
            "pricing_source": pricing_source(mid)}


# --------------------------------------------------------------------------- #
# Custom (self-hosted / LiteLLM / OpenAI-compatible) models — runtime add/remove.
#
# Lets an operator register a SELF-HOSTED model (a LiteLLM alias / vLLM served name /
# Ollama tag) served at an OpenAI-compatible ``base_url``, at runtime, with no rebuild.
# The suite already speaks the wire (the ``openai_compatible`` provider IS the OpenAI
# httpx client pointed at a custom ``base_url``); these routes are the bookkeeping:
#   * config tier (#10): base_url / model id / label / context window / $0 rate → the
#     non-secret CustomModelStore. The optional endpoint API key → the SECRET tier
#     (``Secrets.litellm_api_key``, in-memory) via ``apply_secrets`` — NEVER the store.
#   * $0 pricing (belt-and-suspenders): the store row carries a 0/0 rate AND we set a $0
#     PriceOverlay, so ``cost_for`` meters a REAL $0 (never the conservative default),
#     and the gateway's ``_effective_price_tuple`` treats a registered model as free even
#     if the overlay write was lost.
#   * SSRF/scheme: the base_url scheme is restricted to http/https and must parse; a
#     LAN/loopback host (127.0.0.1 / 192.168.x / litellm:4000) is the LEGITIMATE use
#     case, so private ranges are NOT blocked — only malformed / non-http(s) is rejected.
#   * #9: label / model id / base_url are attacker-influenceable → fenced via ``_safe``
#     and returned PLAIN (the store also bounds + plain-coerces them).
# These routes NEVER touch ``case_manager.decide()`` (#3).
# --------------------------------------------------------------------------- #
def _validate_base_url(raw: str) -> str:
    """A parsed, bounded, http(s)-only ``base_url`` (#10 SSRF hardening: scheme-only —
    private/loopback hosts are allowed as the legitimate local-model case). Raises
    HTTPException(400) on a malformed / non-http(s) url."""
    url = _safe(raw).strip()
    if not url:
        raise HTTPException(status_code=400, detail="base_url is required")
    try:
        parts = urlsplit(url)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail="base_url is malformed") from exc
    if parts.scheme not in ("http", "https") or not parts.netloc:
        raise HTTPException(
            status_code=400,
            detail="base_url must be an http(s) URL (e.g. http://localhost:4000/v1)",
        )
    return url


def _bearer_key(explicit: str | None, state: AppState) -> str:
    """The Bearer key for an OpenAI-compatible reachability probe: an explicit key, else
    the configured LiteLLM/OpenAI secret, else a non-empty placeholder (a no-auth local
    server ignores it; empty is rejected by strict clients)."""
    key = (explicit or "").strip()
    if key:
        return key
    key = (getattr(state.secrets, "litellm_api_key", None)
           or getattr(state.secrets, "openai_api_key", None) or "").strip()
    return key or "sk-no-key"


class CustomModelBody(BaseModel):
    model_config = {"protected_namespaces": ()}

    model_id: str = Field(..., min_length=1, max_length=200)
    base_url: str = Field(..., min_length=1, max_length=2000)
    label: str = Field(default="", max_length=200)
    context_window: int = Field(default=0, ge=0)
    api_key: str | None = Field(default=None, max_length=4000)


@router.post("/llm/models/custom")
async def add_custom_model(
    body: CustomModelBody,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("models", "manage")),
) -> dict[str, Any]:
    mid = _safe(body.model_id).strip()
    if not mid:
        raise HTTPException(status_code=400, detail="model_id is required")
    base_url = _validate_base_url(body.base_url)
    label = _safe(body.label).strip()
    try:
        row = await state.custom_models.add(
            mid, label=label, base_url=base_url, provider="openai_compatible",
            context_window=int(body.context_window or 0),
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=_safe(exc)) from exc
    # Belt-and-suspenders $0: a $0 PriceOverlay so cost_for meters a real $0 (the store
    # row + the gateway's _effective_price_tuple are the other belts). Best-effort.
    try:
        await state.price_overlay.set_price(mid, 0.0, 0.0)
    except Exception as exc:  # noqa: BLE001 — the store row + gateway fallback still guarantee $0
        logger.warning("setting $0 overlay for custom model %s failed (%s)", mid, exc)
    # The optional endpoint key → the SECRET tier (in-memory), NEVER the config store.
    if (body.api_key or "").strip():
        try:
            await state.apply_secrets({"litellm_api_key": body.api_key.strip()})
        except Exception as exc:  # noqa: BLE001 — model still added; key can be re-set
            logger.warning("storing litellm_api_key failed (%s)", exc)
    await _audit(state, request, "custom_model_add",
                 f"added {mid} @ {base_url} (provider=openai_compatible, $0)")
    return {"ok": True, "model": row, "configured": state.secrets.configured_status()}


@router.delete("/llm/models/custom/{model_id:path}")
async def remove_custom_model(
    model_id: str,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("models", "manage")),
) -> dict[str, Any]:
    mid = _safe(model_id).strip()
    removed = await state.custom_models.remove(mid)
    if removed:
        # Clear its $0 overlay so the id is fully forgotten (best-effort).
        try:
            await state.price_overlay.delete(mid)
        except Exception as exc:  # noqa: BLE001
            logger.warning("clearing overlay for removed custom model %s failed (%s)", mid, exc)
        await _audit(state, request, "custom_model_remove", f"removed {mid}")
    return {"ok": True, "model": _safe(mid), "removed": removed}


class ProviderTestBody(BaseModel):
    base_url: str = Field(..., min_length=1, max_length=2000)
    api_key: str | None = Field(default=None, max_length=4000)


@router.post("/llm/providers/test")
async def providers_test(
    body: ProviderTestBody,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("models", "manage")),
) -> dict[str, Any]:
    """A NON-metered reachability + "fetch models" probe for an OpenAI-compatible
    endpoint: ``GET {base_url}/models`` (falling back to ``/v1/models``) with a Bearer
    header. It does NOT touch the gateway / cost ledger (#6). Returns the discovered
    model ids so the Add-local-model dialog can populate a picker. Errors are PLAIN,
    bounded (#9)."""
    base_url = _validate_base_url(body.base_url)
    key = _bearer_key(body.api_key, state)
    headers = {"Authorization": f"Bearer {key}"}
    root = base_url.rstrip("/")
    candidates = [f"{root}/models"]
    # Fall back to /v1/models when the operator gave the bare host (no /v1 suffix).
    if not root.endswith("/v1"):
        candidates.append(f"{root}/v1/models")
    last_err = ""
    async with httpx.AsyncClient(timeout=10.0) as client:
        for url in candidates:
            try:
                resp = await client.get(url, headers=headers)
                resp.raise_for_status()
                data = resp.json()
            except Exception as exc:  # noqa: BLE001 — classify + try the next candidate
                last_err = str(classify_http_error(exc))
                continue
            ids = _extract_model_ids(data)
            return {"ok": True, "models": [_safe(m) for m in ids][:200],
                    "message": f"Reached {_safe(root)} — {len(ids)} model(s)."}
    return {"ok": False, "models": [], "error": _safe(last_err or "unreachable")}


def _extract_model_ids(data: Any) -> list[str]:
    """Model ids from an OpenAI-compatible ``/models`` response (``{"data": [{"id": ...}]}``
    or a bare list). Tolerant of shape drift; returns [] on anything unexpected."""
    rows = data.get("data") if isinstance(data, dict) else data
    if not isinstance(rows, list):
        return []
    out: list[str] = []
    for r in rows:
        mid = r.get("id") if isinstance(r, dict) else r
        if mid:
            out.append(str(mid))
    return out


# --------------------------------------------------------------------------- #
# POST /api/cost/estimate — a pre-flight USD estimate for a prompt + token budget
# --------------------------------------------------------------------------- #
class EstimateBody(BaseModel):
    model: str = Field(..., min_length=1, max_length=200)
    prompt: str = Field(default="", max_length=200000)
    prompt_chars: int | None = Field(default=None, ge=0)
    max_tokens: int = Field(default=1000, ge=0)


@router.post("/cost/estimate")
async def cost_estimate(
    body: EstimateBody,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("models", "read")),
) -> dict[str, Any]:
    mid = body.model.strip()
    overlay = None
    try:
        overlay = await state.price_overlay.as_price_tuple(mid)
    except Exception:  # noqa: BLE001 — advisory; estimate falls back to the table
        overlay = None
    gate = _budget_gate(state)
    chars = body.prompt_chars if body.prompt_chars is not None else len(body.prompt)
    estimate = gate.estimate_cost(chars, body.max_tokens, mid, overlay)
    return {
        "model": _safe(mid),
        "prompt_chars": chars,
        "max_tokens": body.max_tokens,
        "estimated_cost": estimate,
        "currency": "USD",
        "pricing_source": "exact" if overlay is not None else pricing_source(mid),
    }


# --------------------------------------------------------------------------- #
# GET/PUT /api/budget — the LLM cost-budget ceiling config
# --------------------------------------------------------------------------- #
@router.get("/budget")
async def get_budget(
    state: AppState = Depends(get_state),
    _=Depends(require_permission("models", "read")),
) -> dict[str, Any]:
    budget = getattr(state.prefs, "budget", None) or BudgetConfig()
    return {"budget": budget.model_dump(mode="json")}


@router.put("/budget")
async def put_budget(
    body: BudgetConfig,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("models", "manage")),
) -> dict[str, Any]:
    await state.mutate_prefs(
        lambda current: current.model_copy(update={"budget": body})
    )
    await _audit(
        state, request, "budget_update",
        f"budget enabled={body.enabled} daily=${body.daily_usd} "
        f"monthly=${body.monthly_usd} on_exceed={body.on_exceed}",
    )
    return {"ok": True, "budget": body.model_dump(mode="json")}


@router.get("/budget/status")
async def budget_status(
    state: AppState = Depends(get_state),
    _=Depends(require_permission("models", "read")),
) -> dict[str, Any]:
    gate = _budget_gate(state)
    return await gate.status()


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def _budget_gate(state: AppState):
    """The shared BudgetGate if the integrator wired one onto AppState; else a
    transient gate built from the live prefs + the real usage store. Either way it is
    PURE (read-only) and never touches decide() (#3)."""
    gate = getattr(state, "budget_gate", None)
    if gate is not None:
        return gate
    from ..engine.budget import BudgetGate

    usage = getattr(state, "_real_usage_store", None) or getattr(state, "usage", None)
    return BudgetGate(get_budget=lambda: getattr(state.prefs, "budget", None), usage_store=usage)


async def _audit(state: AppState, request: Request, event: str, detail: str) -> None:
    """Append-only audit of a models/budget config mutation (#2). Best-effort.

    Uses ``USER_MGMT`` with ``surface="models"`` — the established action type for an
    operator settings-scope mutation (constants.py is frozen this wave, so no new
    ActionType is introduced). The actor is the authenticated username when present."""
    audit = getattr(state, "control_audit", None)
    if audit is None:
        return
    try:
        from ..constants import ActionType

        await audit.record(
            action_type=ActionType.USER_MGMT,
            surface="models",
            actor=current_username(request) or "",
            result_summary=f"{event}: {detail}"[:500],
        )
    except Exception:  # noqa: BLE001
        pass
