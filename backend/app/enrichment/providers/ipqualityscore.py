"""IPQualityScore enrichment provider (Round 11) — key-gated, IP/URL/email fraud.

IPQS returns a GRADED 0..100 ``fraud_score`` (IP/email) or ``risk_score`` (URL) plus
proxy/VPN/Tor/bot flags — a direct map onto our 0..100 scale. Key-gated
(``Secrets.ipqualityscore_api_key``). NOTE: IPQS puts the key in the URL PATH
(``/api/json/ip/{key}/{ip}``); ``http_json``'s redaction only scrubs the QUERY
string, so this provider catches ``HTTPStatusError`` itself and re-raises a
sanitised message — the key can never reach the recorded error / logs / UI
(#10 / audit #5). Every flag is UNTRUSTED and fenced before a prompt (#9).
"""

from __future__ import annotations

from urllib.parse import quote

import httpx

from ...constants import IndicatorKind
from ...models import ProviderResult
from ...utils import now_utc
from ..base import EnrichmentProvider, ProviderManifest, ProviderSecretField
from ._common import http_json, rate_guard

_BASE = "https://www.ipqualityscore.com/api/json"


class IPQualityScoreProvider(EnrichmentProvider):
    name = "ipqualityscore"

    @classmethod
    def manifest(cls) -> ProviderManifest:
        return ProviderManifest(
            name=cls.name,
            display_name="IPQualityScore",
            description=(
                "Fraud scoring for IPs, URLs and email addresses: a 0..100 fraud/"
                "risk score plus proxy, VPN, Tor, bot and disposable-email flags."
            ),
            indicator_kinds=[IndicatorKind.IP, IndicatorKind.URL, IndicatorKind.EMAIL],
            config_key="use_ipqualityscore",
            secret_fields=[
                ProviderSecretField(
                    key="ipqualityscore_api_key",
                    label="IPQualityScore API key",
                    required=True,
                    help="Free API key from your IPQS account (~5,000 lookups/month).",
                    help_link="https://www.ipqualityscore.com/create-account",
                ),
            ],
            keyless=False,
            free_tier="~5,000 lookups/month (free key)",
            docs_url="https://www.ipqualityscore.com/documentation/overview",
            default_enabled=False,
            setup_steps=[
                "Create a free account at ipqualityscore.com (~5,000 lookups/month "
                "on the free plan).",
                "Copy the API key from Settings → API Keys.",
                "Set TLSOC_IPQUALITYSCORE_API_KEY in .env (compose maps it to "
                "IPQUALITYSCORE_API_KEY), or paste it in this card (in-memory until "
                "restart).",
                "Flip this provider's toggle ON — one key covers IP, URL and email "
                "lookups.",
            ],
            example=(
                "A login attempt scoring fraud 92 with 'proxy + recent abuse' flags "
                "is prioritised as account takeover, while the same alert on a "
                "fraud-score-5 residential IP with no flags drops down the queue."
            ),
        )

    def _endpoint(self, key: str, value: str, kind: IndicatorKind) -> str:
        if kind == IndicatorKind.IP:
            return f"{_BASE}/ip/{key}/{quote(value, safe='')}"
        if kind == IndicatorKind.EMAIL:
            return f"{_BASE}/email/{key}/{quote(value, safe='')}"
        if kind == IndicatorKind.URL:
            return f"{_BASE}/url/{key}/{quote(value, safe='')}"
        raise ValueError(f"ipqualityscore: unsupported kind {kind.value}")

    async def _lookup(self, value: str, kind: IndicatorKind) -> ProviderResult:
        key = self._secret("ipqualityscore_api_key")
        if not key:
            return ProviderResult(
                provider=self.name, indicator=value, indicator_kind=kind.value,
                ok=False, error="ipqualityscore: no api key",
            )
        await rate_guard(self.name)
        try:
            data = await http_json(self._endpoint(key, value, kind))
        except httpx.HTTPStatusError as exc:
            # The key lives in the URL PATH — never let it into the recorded error.
            raise RuntimeError(
                f"ipqualityscore: HTTP {exc.response.status_code}"
            ) from None
        data = data if isinstance(data, dict) else {}
        if data.get("success") is False:
            # IPQS answers 200 with success=false for a bad request/quota issue.
            # The message may embed request detail — record a generic error only.
            return ProviderResult(
                provider=self.name, indicator=value, indicator_kind=kind.value,
                ok=False, error="ipqualityscore: query rejected (success=false)",
            )
        raw_score = data.get("fraud_score", data.get("risk_score"))
        try:
            score = int(max(0.0, min(100.0, float(raw_score))))
        except (TypeError, ValueError):
            score = 0
        flags: list[str] = []
        for flag in ("proxy", "vpn", "tor", "active_vpn", "active_tor", "bot_status",
                     "recent_abuse", "phishing", "malware", "suspicious", "disposable",
                     "honeypot", "leaked"):
            if data.get(flag) is True:
                flags.append(flag)
        return ProviderResult(
            provider=self.name, indicator=value, indicator_kind=kind.value,
            # Graded reputation: the 0..100 fraud/risk score maps directly (#3
            # discipline for graded feeds).
            score=score, malicious=score >= 50, confidence=0.7,
            tags=flags[:10],
            raw={
                "fraud_score": raw_score,
                "flags": flags,
                "country": data.get("country_code"),
                "isp": data.get("ISP") or data.get("isp"),
                "domain": data.get("domain"),
            },
            ok=True, ts=now_utc(),
        )
