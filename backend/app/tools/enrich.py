"""IP / indicator enrichment tool (Section 6.5 / Non-negotiable #8).

Resolves an indicator's reputation against external threat-intel providers with a
Redis-backed cache in front to protect both cost and tight free-tier API limits.
Enrichment NEVER breaks an investigation: every provider or network failure is
caught, logged and turned into a best-effort, neutral result, so a flaky third party
can degrade the signal but never crash the engine.

Round 3 — multi-provider SPI. The actual provider calls now go through the
:mod:`app.enrichment` SPI (registry → dispatch → providers), so adding a provider is
a drop-in under ``app/enrichment/providers/`` with NO change here. This tool stays a
THIN compatibility facade:

  * :meth:`EnrichTool.enrich_ip` returns the SAME :class:`app.models.EnrichmentResult`
    shape the deterministic risk scorer + the threat-context panel already consume
    (``sources`` dict, ``reputation_score`` = legacy ``max(score)``, the ``enrich:<ip>``
    cache key) — byte-compatible, so ``engine/risk.py`` + ``engine/threat_context.py``
    + the existing tests are UNCHANGED.
  * :meth:`EnrichTool.enrich_indicator` is the new multi-indicator entry returning the
    raw :class:`app.models.ProviderResult` list (Wave 2 wires it into threat_context
    for non-IP indicators).

``run`` is the thin MCP-shaped wrapper around ``enrich_ip``.
"""

from __future__ import annotations

import ipaddress
import logging
from dataclasses import dataclass, field
from typing import Any

from ..cache import Cache
from ..config import Preferences, Secrets
from ..constants import IndicatorKind
from ..enrichment import enrich_indicator as _dispatch_enrich
from ..enrichment.aggregate import fuse
from ..models import EnrichmentResult, ProviderResult
from .base import Tool, ToolResult

logger = logging.getLogger("tlsoc.tools.enrich")

#: How the per-provider results behind an ``enrich_ip`` answer were found (Round 16,
#: [dv] R7): the providers were asked now; they were kept beside a cached answer; the
#: cached answer was kept without them (an earlier build wrote it); no provider was
#: asked (a private or invalid address, or enrichment switched off).
DETAIL_CHECKED = "checked"
DETAIL_CACHED = "cached"
DETAIL_NOT_RECORDED = "not_recorded"
DETAIL_SKIPPED = "skipped"


@dataclass
class IpEnrichmentDetail:
    """The per-provider results behind one :meth:`EnrichTool.enrich_ip` answer, filled
    through an object the caller owns (``detail=``), as the gateway fills a usage
    receipt. ``providers`` are the raw :class:`app.models.ProviderResult` values (their
    strings are UNTRUSTED provider data: fence them before showing them, #9);
    ``status`` is one of the ``DETAIL_*`` values."""

    providers: list[ProviderResult] = field(default_factory=list)
    status: str = ""


def _fill(detail: IpEnrichmentDetail | None, providers: list[ProviderResult], status: str) -> None:
    if detail is not None:
        detail.providers = list(providers)
        detail.status = status


def _providers_cache_key(ip: str) -> str:
    """Where the per-provider results of a cached ``enrich:<ip>`` answer are kept."""
    return f"enrich:ip-providers:v1:{ip}"


class EnrichTool(Tool):
    name = "enrich"
    description = (
        "Look up the reputation of an external IP address against threat-intel "
        "providers (AbuseIPDB, VirusTotal). Returns a 0-100 reputation score, a "
        "malicious flag and the originating country. Private/invalid IPs are "
        "skipped. Results are cached to respect free-tier limits."
    )
    input_schema = {
        "type": "object",
        "properties": {
            "ip": {"type": "string", "description": "the IP address to enrich"},
        },
        "required": ["ip"],
        "additionalProperties": False,
    }

    def __init__(self, secrets: Secrets, prefs: Preferences, cache: Cache) -> None:
        self._secrets = secrets
        self._prefs = prefs
        self._cache = cache

    # ----- reusable core (the risk scorer calls this directly) -----
    async def enrich_ip(self, ip: str, *, detail: IpEnrichmentDetail | None = None) -> EnrichmentResult:
        """Resolve reputation for ``ip``. Never raises — always returns a result.

        Delegates provider calls to the enrichment SPI but keeps the LEGACY
        ``EnrichmentResult`` shape + ``enrich:<ip>`` cache so callers are unchanged.

        Round 16 (SPEC §4.5 WP13, [dv] R7): ``detail``, an object the caller owns, is
        filled with the per-provider results behind the answer (the providers asked
        now, or the ones kept beside a cached answer) and how they were found. The
        result itself, its cache key and its cache rule are unchanged; the provider
        results of a cached answer are kept under their own key with the same TTL."""
        cfg = self._prefs.enrichment

        # 1) Validate / skip private, loopback, reserved or invalid addresses.
        if not _is_public_ip(ip):
            _fill(detail, [], DETAIL_SKIPPED)
            return EnrichmentResult(
                ip=ip,
                reputation_score=0,
                is_malicious=False,
                sources={"note": "private/invalid; skipped"},
            )

        # 2) Enrichment disabled by preference — neutral result, no providers.
        if not cfg.enabled:
            _fill(detail, [], DETAIL_SKIPPED)
            return EnrichmentResult(
                ip=ip,
                reputation_score=0,
                is_malicious=False,
                sources={"note": "disabled"},
            )

        # 3) Cache hit returns the stored result flagged as cached (LEGACY key).
        cache_key = f"enrich:{ip}"
        try:
            cached = await self._cache.get_json(cache_key)
        except Exception as exc:  # noqa: BLE001
            logger.warning("enrich cache read failed for %s: %s", ip, exc)
            cached = None
        if cached:
            result = EnrichmentResult.model_validate(cached)
            result.cached = True
            if detail is not None:
                kept = await self._cached_providers(ip)
                _fill(detail, kept or [], DETAIL_CACHED if kept is not None else DETAIL_NOT_RECORDED)
            return result

        # 4) Query the enabled IP providers via the SPI; best-effort, never raises.
        #    NOTE: we pass cache=None to the dispatcher so the per-provider v2 cache
        #    does not double-cache; the legacy result-level cache below is authoritative
        #    for enrich_ip's exact prior behaviour (test_second_call_is_cached).
        provider_results = await _dispatch_enrich(
            ip, IndicatorKind.IP, cfg, self._secrets, cache=None
        )
        result = self._to_enrichment_result(ip, provider_results, cfg)
        _fill(detail, provider_results, DETAIL_CHECKED)

        # 5) Cache only successful (non-error) results (LEGACY behaviour).
        if result.error is None:
            try:
                await self._cache.set_json(
                    cache_key, result.model_dump(mode="json"), cfg.cache_ttl_seconds
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning("enrich cache write failed for %s: %s", ip, exc)
            # Round 16: the per-provider results behind that answer, beside it with the
            # same TTL, so a later reader of the cached answer can say which provider
            # gave what. Best-effort: a missed write only reads "not recorded".
            try:
                await self._cache.set_json(
                    _providers_cache_key(ip),
                    {"v": 1, "providers": [r.model_dump(mode="json") for r in provider_results]},
                    cfg.cache_ttl_seconds,
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning("enrich provider cache write failed for %s: %s", ip, exc)

        return result

    async def _cached_providers(self, ip: str) -> list[ProviderResult] | None:
        """The per-provider results kept beside the cached answer for ``ip``, each
        marked ``_cached`` like a per-provider cache hit; ``None`` when none were kept
        (an earlier build wrote the answer, or the entry expired first)."""
        try:
            kept = await self._cache.get_json(_providers_cache_key(ip))
        except Exception as exc:  # noqa: BLE001
            logger.warning("enrich provider cache read failed for %s: %s", ip, exc)
            return None
        if not isinstance(kept, dict) or kept.get("v") != 1 or not isinstance(kept.get("providers"), list):
            return None
        out: list[ProviderResult] = []
        for item in kept["providers"]:
            try:
                result = ProviderResult.model_validate(item)
            except Exception:  # noqa: BLE001 (a bad entry reads as not recorded)
                return None
            result.raw = {**(result.raw or {}), "_cached": True}
            out.append(result)
        return out

    # ----- new multi-indicator entry (Wave 2 wires it into threat_context) -----
    async def enrich_indicator(self, value: str, kind: IndicatorKind) -> list[ProviderResult]:
        """Enrich ANY indicator kind, returning the raw per-provider results.

        Uses the shared Redis cache (the per-provider v2 cache). Never raises."""
        return await _dispatch_enrich(
            value, kind, self._prefs.enrichment, self._secrets, cache=self._cache
        )

    # ----- legacy-shape assembly (max(score), sources dict, country) -----
    def _to_enrichment_result(
        self, ip: str, results: list[ProviderResult], cfg: Any
    ) -> EnrichmentResult:
        """Collapse provider results into the LEGACY ``EnrichmentResult`` shape.

        ``reputation_score`` uses :func:`app.enrichment.aggregate.fuse` whose default
        is byte-identical ``max(score)`` (#3); the ``sources`` dict + per-provider
        error keys + the ``use_geoip``-gated country reproduce the legacy field names
        exactly so ``risk.py``/``threat_context.py``/the tests are unchanged."""
        sources: dict[str, Any] = {}
        country: str | None = None
        error: str | None = None
        for r in results:
            if r.score is not None:
                sources[r.provider] = r.score
            if r.error:
                sources[f"{r.provider}_error"] = r.error
                error = r.error
            if cfg.use_geoip and country is None:
                c = (r.raw or {}).get("country") or (r.raw or {}).get("countryCode")
                if c:
                    country = str(c)

        fused = fuse(results, cfg)
        reputation_score = max(0.0, min(100.0, float(fused.reputation_score)))
        return EnrichmentResult(
            ip=ip,
            reputation_score=reputation_score,
            is_malicious=reputation_score >= 50,
            country=country,
            sources=sources,
            error=error,
        )

    # ----- MCP-shaped wrapper -----
    async def run(self, ip: str = "", **kwargs: Any) -> ToolResult:
        result = await self.enrich_ip(ip)
        verdict = "malicious" if result.is_malicious else "clean"
        summary = (
            f"{result.ip}: reputation {result.reputation_score:.0f}/100 ({verdict})"
            + (f", country {result.country}" if result.country else "")
            + (" [cached]" if result.cached else "")
        )
        return ToolResult(
            ok=result.error is None,
            summary=summary,
            data=result.model_dump(),
            error=result.error,
            meta={"ip": result.ip, "cached": result.cached},
        )


def _is_public_ip(ip: str) -> bool:
    """True only for syntactically valid, globally routable addresses."""
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    return not (
        addr.is_private
        or addr.is_loopback
        or addr.is_reserved
        or addr.is_link_local
        or addr.is_multicast
        or addr.is_unspecified
    )
