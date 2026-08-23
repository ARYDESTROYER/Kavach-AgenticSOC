"""AbuseIPDB enrichment provider (Round 3 — refactor of the legacy EnrichTool path).

Scores an IP against AbuseIPDB's crowd-sourced abuse confidence. The scoring is kept
BYTE-IDENTICAL to the legacy ``EnrichTool._query_abuseipdb``: the 0..100 score is the
raw ``abuseConfidenceScore``, the country comes from ``countryCode``. Key-gated
(``Secrets.abuseipdb_api_key``); only handles :class:`IndicatorKind.IP`.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

from ...constants import IndicatorKind
from ...models import ProviderResult
from ...utils import now_utc
from ..base import EnrichmentProvider, ProviderManifest, ProviderSecretField

logger = logging.getLogger("tlsoc.enrichment.abuseipdb")

_TIMEOUT = 8.0
_ABUSEIPDB_URL = "https://api.abuseipdb.com/api/v2/check"


class AbuseIPDBProvider(EnrichmentProvider):
    name = "abuseipdb"

    @classmethod
    def manifest(cls) -> ProviderManifest:
        return ProviderManifest(
            name=cls.name,
            display_name="AbuseIPDB",
            description=(
                "Crowd-sourced IP abuse reputation (0..100 abuse-confidence). "
                "Free tier: ~1000 checks/day with a free API key."
            ),
            indicator_kinds=[IndicatorKind.IP],
            config_key="use_abuseipdb",
            secret_fields=[
                ProviderSecretField(
                    key="abuseipdb_api_key",
                    label="AbuseIPDB API key",
                    required=True,
                    help="Free API key from your AbuseIPDB account (Account → API).",
                    help_link="https://www.abuseipdb.com/account/api",
                ),
            ],
            keyless=False,
            free_tier="~1000 checks/day (free key required)",
            docs_url="https://docs.abuseipdb.com/",
            default_enabled=True,
            setup_steps=[
                "Create a free account at abuseipdb.com and open Account → API.",
                "Create an API key (the free tier allows ~1,000 checks/day).",
                "Set TLSOC_ABUSEIPDB_API_KEY in .env (compose maps it to "
                "ABUSEIPDB_API_KEY), or paste the key in this card — UI-set keys are "
                "in-memory only and are lost on restart.",
                "The provider is enabled by default; it starts firing as soon as the "
                "key is present.",
            ],
            example=(
                "An SSH brute-force alert from an IP with a 100/100 abuse-confidence "
                "score and 400 prior reports is a very different case from one with a "
                "clean history — the crowd-sourced score separates known scanners "
                "from first-seen sources instantly."
            ),
        )

    async def _lookup(self, value: str, kind: IndicatorKind) -> ProviderResult:
        key = self._secret("abuseipdb_api_key")
        if not key:
            return ProviderResult(
                provider=self.name,
                indicator=value,
                indicator_kind=kind.value,
                ok=False,
                error="abuseipdb: no api key",
            )
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            resp = await client.get(
                _ABUSEIPDB_URL,
                params={"ipAddress": value, "maxAgeInDays": 90},
                headers={"Key": key, "Accept": "application/json"},
            )
            resp.raise_for_status()
            data: dict[str, Any] = resp.json().get("data", {}) or {}
        # IDENTICAL semantics to the legacy EnrichTool._query_abuseipdb.
        confidence = float(data.get("abuseConfidenceScore", 0) or 0)
        country = data.get("countryCode") or None
        score = int(max(0.0, min(100.0, confidence)))
        tags: list[str] = []
        usage_type = data.get("usageType")
        if usage_type:
            tags.append(str(usage_type))
        if data.get("isTor"):
            tags.append("tor")
        return ProviderResult(
            provider=self.name,
            indicator=value,
            indicator_kind=kind.value,
            score=score,
            malicious=score >= 50,
            confidence=confidence / 100.0,
            tags=tags,
            raw={
                "abuseConfidenceScore": confidence,
                "countryCode": country,
                "usageType": usage_type,
                "totalReports": data.get("totalReports"),
                "isp": data.get("isp"),
            },
            ok=True,
            ts=now_utc(),
        )
