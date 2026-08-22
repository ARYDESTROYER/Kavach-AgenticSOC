"""AlienVault OTX enrichment provider (Round 3 Wave 2) — key-gated, multi-indicator.

OTX (Open Threat Exchange) ``/api/v1/indicators/{section}/{value}/general`` returns the
community *pulses* (threat reports) an indicator appears in across IPs, domains, URLs
and file hashes. We score on pulse count: 0 pulses → 0, 1 → 40, 2 → 60, ≥3 → 80 (so a
heavily-reported indicator clears the 50 malicious cut). Key-gated
(``Secrets.otx_api_key``, the ``X-OTX-API-KEY`` header). Every pulse name / tag is
UNTRUSTED, community-authored text and is fenced before a prompt (#9).
"""

from __future__ import annotations

from ...constants import IndicatorKind
from ...models import ProviderResult
from ...utils import now_utc
from ..base import EnrichmentProvider, ProviderManifest, ProviderSecretField
from ._common import http_json, rate_guard

_BASE = "https://otx.alienvault.com/api/v1/indicators"
# Map our IndicatorKind onto the OTX URL section.
_SECTION = {
    IndicatorKind.IP: "IPv4",
    IndicatorKind.DOMAIN: "domain",
    IndicatorKind.URL: "url",
    IndicatorKind.FILE_HASH: "file",
}


def _score_for_pulses(n: int) -> int:
    if n <= 0:
        return 0
    if n == 1:
        return 40
    if n == 2:
        return 60
    return 80


class OTXProvider(EnrichmentProvider):
    name = "otx"

    @classmethod
    def manifest(cls) -> ProviderManifest:
        return ProviderManifest(
            name=cls.name,
            display_name="AlienVault OTX",
            description=(
                "Community threat-intel pulses for IPs, domains, URLs and file hashes. "
                "Score rises with the number of reporting pulses."
            ),
            indicator_kinds=[
                IndicatorKind.IP, IndicatorKind.DOMAIN, IndicatorKind.URL, IndicatorKind.FILE_HASH,
            ],
            config_key="use_otx",
            secret_fields=[
                ProviderSecretField(
                    key="otx_api_key",
                    label="OTX API key",
                    required=True,
                    help="Free API key from your AlienVault OTX account (Settings → API).",
                    help_link="https://otx.alienvault.com/api",
                ),
            ],
            keyless=False,
            free_tier="Free with an OTX account",
            docs_url="https://otx.alienvault.com/api",
            default_enabled=False,
            setup_steps=[
                "Create a free account at otx.alienvault.com and open Settings → "
                "API Integration.",
                "Copy the OTX API key (free, generous limits).",
                "Set TLSOC_OTX_API_KEY in .env (compose maps it to OTX_API_KEY), or "
                "paste it in this card (in-memory until restart).",
                "Flip this provider's toggle ON — one key covers IPs, domains, URLs "
                "and hashes.",
            ],
            example=(
                "Ties an indicator to named community campaigns: a domain sitting in "
                "four OTX pulses titled 'AgentTesla phishing wave' immediately "
                "explains WHAT the alert likely is, not just that it is bad."
            ),
        )

    async def _lookup(self, value: str, kind: IndicatorKind) -> ProviderResult:
        key = self._secret("otx_api_key")
        if not key:
            return ProviderResult(
                provider=self.name, indicator=value, indicator_kind=kind.value,
                ok=False, error="otx: no api key",
            )
        section = _SECTION.get(kind)
        if section is None:
            return ProviderResult(
                provider=self.name, indicator=value, indicator_kind=kind.value,
                ok=False, error=f"otx: unsupported kind {kind.value}",
            )
        await rate_guard(self.name)
        data = await http_json(
            f"{_BASE}/{section}/{value}/general",
            headers={"X-OTX-API-KEY": key, "Accept": "application/json"},
        )
        data = data if isinstance(data, dict) else {}
        pulse_info = data.get("pulse_info") or {}
        pulses = pulse_info.get("pulses") or []
        count = int(pulse_info.get("count") or len(pulses) or 0)
        score = _score_for_pulses(count)
        names = [str(p.get("name")) for p in pulses if isinstance(p, dict) and p.get("name")]
        tags: list[str] = [f"pulses:{count}"]
        tags.extend(names[:5])
        return ProviderResult(
            provider=self.name, indicator=value, indicator_kind=kind.value,
            score=score, malicious=score >= 50, confidence=min(1.0, count / 3.0) if count else 0.2,
            tags=tags,
            raw={
                "pulse_count": count,
                "pulse_names": names[:10],
                "country": data.get("country_name") or data.get("country_code"),
                "countryCode": data.get("country_code"),
                "asn": data.get("asn"),
            },
            ok=True, ts=now_utc(),
        )
