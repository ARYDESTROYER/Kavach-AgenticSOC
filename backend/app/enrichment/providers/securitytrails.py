"""SecurityTrails enrichment provider (Round 11) — key-gated, domain context.

SecurityTrails' ``/v1/domain/{domain}`` returns DNS/hosting posture: current A/MX/NS
records, subdomain count and hostname metadata. PURE infrastructure context — score
is ALWAYS 0 and ``malicious`` always False (#3); its value is corroboration (does
this domain actually resolve, how much infrastructure sits behind it) next to
RDAP's registration-age signal. Key-gated (``Secrets.securitytrails_api_key``, the
``APIKEY`` header); the free tier is tiny (50 queries/month) so the Redis cache
matters. Record values are UNTRUSTED and fenced before a prompt (#9).
"""

from __future__ import annotations

from urllib.parse import quote

from ...constants import IndicatorKind
from ...models import ProviderResult
from ...utils import now_utc
from ..base import EnrichmentProvider, ProviderManifest, ProviderSecretField
from ._common import http_json, rate_guard

_URL = "https://api.securitytrails.com/v1/domain/{domain}"


class SecurityTrailsProvider(EnrichmentProvider):
    name = "securitytrails"

    @classmethod
    def manifest(cls) -> ProviderManifest:
        return ProviderManifest(
            name=cls.name,
            display_name="SecurityTrails",
            description=(
                "DNS / hosting posture for a domain: current records, subdomain "
                "count and hostname metadata. Infrastructure context, never a "
                "verdict."
            ),
            indicator_kinds=[IndicatorKind.DOMAIN],
            config_key="use_securitytrails",
            secret_fields=[
                ProviderSecretField(
                    key="securitytrails_api_key",
                    label="SecurityTrails API key",
                    required=True,
                    help="Free API key (50 queries/month) from your SecurityTrails account.",
                    help_link="https://securitytrails.com/app/account/credentials",
                ),
            ],
            keyless=False,
            free_tier="Free tier: 50 queries/month (cache does the heavy lifting)",
            docs_url="https://docs.securitytrails.com/reference",
            default_enabled=False,
            setup_steps=[
                "Sign up free at securitytrails.com and open Account → API keys "
                "(free tier: 50 queries/month).",
                "Set TLSOC_SECURITYTRAILS_API_KEY in .env (compose maps it to "
                "SECURITYTRAILS_API_KEY), or paste it in this card (in-memory until "
                "restart).",
                "Flip this provider's toggle ON — the 6h Redis cache stretches the "
                "small quota across repeated lookups.",
            ],
            example=(
                "The suspicious domain resolves to one throwaway VPS, has zero MX "
                "records and two subdomains — single-purpose phishing "
                "infrastructure, unlike a real business domain with mail and dozens "
                "of subdomains."
            ),
        )

    async def _lookup(self, value: str, kind: IndicatorKind) -> ProviderResult:
        key = self._secret("securitytrails_api_key")
        if not key:
            return ProviderResult(
                provider=self.name, indicator=value, indicator_kind=kind.value,
                ok=False, error="securitytrails: no api key",
            )
        await rate_guard(self.name)
        data = await http_json(
            _URL.format(domain=quote(value.strip().strip(".").lower(), safe="")),
            headers={"APIKEY": key, "Accept": "application/json"},
        )
        if not isinstance(data, dict):
            return ProviderResult(
                provider=self.name, indicator=value, indicator_kind=kind.value,
                score=0, malicious=False, tags=[], raw={"seen": False},
                ok=True, ts=now_utc(),
            )
        current_dns = data.get("current_dns") or {}
        a_values = [
            str(v.get("ip"))
            for v in ((current_dns.get("a") or {}).get("values") or [])
            if isinstance(v, dict) and v.get("ip")
        ]
        mx_count = len(((current_dns.get("mx") or {}).get("values") or []))
        ns_count = len(((current_dns.get("ns") or {}).get("values") or []))
        subdomain_count = data.get("subdomain_count")
        tags: list[str] = []
        if a_values:
            tags.append(f"resolves:{a_values[0]}")
        if isinstance(subdomain_count, int):
            tags.append(f"subdomains:{subdomain_count}")
        if mx_count == 0:
            tags.append("no_mx")
        return ProviderResult(
            provider=self.name, indicator=value, indicator_kind=kind.value,
            # Pure context: ALWAYS 0 / non-malicious (#3-safe).
            score=0, malicious=False, confidence=0.3,
            tags=tags,
            raw={
                "seen": True,
                "a_records": a_values[:10],
                "mx_count": mx_count,
                "ns_count": ns_count,
                "subdomain_count": subdomain_count,
                "apex_domain": data.get("apex_domain"),
            },
            ok=True, ts=now_utc(),
        )
