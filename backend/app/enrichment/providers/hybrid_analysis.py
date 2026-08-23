"""Hybrid Analysis enrichment provider (Round 11) — key-gated, file-hash sandbox.

Hybrid Analysis (CrowdStrike Falcon Sandbox community) ``/api/v2/search/hash``
returns prior sandbox reports for a hash: a ``verdict`` (malicious / suspicious /
whitelisted / no specific threat), a 0..100 ``threat_score`` and the detected
``vx_family``. VERDICT feed: 'malicious' → 90 (floored — a sandbox conviction is a
strong known-bad), 'suspicious' → 60, whitelisted/none → 0. Key-gated
(``Secrets.hybrid_analysis_api_key``, the ``api-key`` header; the API also requires
an explicit ``User-Agent``). Family names are UNTRUSTED and fenced before a prompt
(#9).
"""

from __future__ import annotations

from ...constants import IndicatorKind
from ...models import ProviderResult
from ...utils import now_utc
from ..base import EnrichmentProvider, ProviderManifest, ProviderSecretField
from ._common import http_json, rate_guard

_URL = "https://www.hybrid-analysis.com/api/v2/search/hash"


class HybridAnalysisProvider(EnrichmentProvider):
    name = "hybrid_analysis"

    @classmethod
    def manifest(cls) -> ProviderManifest:
        return ProviderManifest(
            name=cls.name,
            display_name="Hybrid Analysis",
            description=(
                "Falcon Sandbox community reports for a file hash: sandbox verdict, "
                "threat score and malware family from real detonations."
            ),
            indicator_kinds=[IndicatorKind.FILE_HASH],
            config_key="use_hybrid_analysis",
            secret_fields=[
                ProviderSecretField(
                    key="hybrid_analysis_api_key",
                    label="Hybrid Analysis API key",
                    required=True,
                    help="Free vetted API key from your hybrid-analysis.com profile.",
                    help_link="https://www.hybrid-analysis.com/my-account?tab=%23api-key-tab",
                ),
            ],
            keyless=False,
            free_tier="Free vetted key (~200 requests/hour)",
            docs_url="https://www.hybrid-analysis.com/docs/api/v2",
            default_enabled=False,
            setup_steps=[
                "Create a free account at hybrid-analysis.com and complete the "
                "(quick) vetting step.",
                "Generate an API key under My Account → API key.",
                "Set TLSOC_HYBRID_ANALYSIS_API_KEY in .env (compose maps it to "
                "HYBRID_ANALYSIS_API_KEY), or paste it in this card (in-memory "
                "until restart).",
                "Flip this provider's toggle ON.",
            ],
            example=(
                "A hash with a prior sandbox detonation verdict 'malicious, family "
                "RedLine Stealer, threat score 100' hands the analyst a behavioural "
                "conviction — stronger evidence than static AV ratios alone."
            ),
        )

    async def _lookup(self, value: str, kind: IndicatorKind) -> ProviderResult:
        key = self._secret("hybrid_analysis_api_key")
        if not key:
            return ProviderResult(
                provider=self.name, indicator=value, indicator_kind=kind.value,
                ok=False, error="hybrid_analysis: no api key",
            )
        await rate_guard(self.name)
        data = await http_json(
            _URL, method="POST",
            data={"hash": value.strip().lower()},
            headers={
                "api-key": key,
                # The v2 API rejects requests without an explicit User-Agent.
                "User-Agent": "Falcon Sandbox",
                "Accept": "application/json",
            },
        )
        reports = data if isinstance(data, list) else []
        reports = [r for r in reports if isinstance(r, dict)]
        if not reports:
            return ProviderResult(
                provider=self.name, indicator=value, indicator_kind=kind.value,
                score=0, malicious=False, tags=[], raw={"seen": False},
                ok=True, ts=now_utc(),
            )
        verdicts = [str(r.get("verdict") or "").lower() for r in reports]
        threat_scores = []
        for r in reports:
            try:
                threat_scores.append(int(r.get("threat_score")))
            except (TypeError, ValueError):
                pass
        families = sorted({str(r.get("vx_family")) for r in reports if r.get("vx_family")})
        if "malicious" in verdicts:
            # Sandbox conviction — a true verdict feed (#3 discipline: 80-90 floor).
            score = max(90, max(threat_scores) if threat_scores else 0)
            score = min(100, score)
            malicious = True
        elif "suspicious" in verdicts:
            score = 60
            malicious = True
        else:
            score = 0
            malicious = False
        tags: list[str] = [f"verdict:{v}" for v in sorted(set(verdicts))[:3] if v]
        tags.extend(f"family:{f}" for f in families[:5])
        return ProviderResult(
            provider=self.name, indicator=value, indicator_kind=kind.value,
            score=score, malicious=malicious, confidence=0.85 if malicious else 0.4,
            tags=tags,
            raw={
                "seen": True,
                "reports": len(reports),
                "verdicts": sorted(set(verdicts))[:5],
                "threat_score": max(threat_scores) if threat_scores else None,
                "families": families[:10],
            },
            ok=True, ts=now_utc(),
        )
