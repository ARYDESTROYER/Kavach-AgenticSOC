"""Netlas enrichment provider (Round 11) — key-gated, host exposure context.

Netlas' ``/api/host/{target}`` returns what its internet scans know about an IP or
domain: DNS records, related domains, WHOIS and exposure metadata. Same posture as
Shodan/Censys: EXPOSURE context, not a verdict — score 0, bumped to 20 only when
the host clearly carries scanned-out infrastructure, ``malicious=False`` always
(#3). Key-gated (``Secrets.netlas_api_key``, the ``X-API-Key`` header). The
response shape is broad and loosely versioned, so parsing is defensive — anything
missing degrades to fewer tags, never an error. All values are UNTRUSTED and
fenced before a prompt (#9).
"""

from __future__ import annotations

from urllib.parse import quote

from ...constants import IndicatorKind
from ...models import ProviderResult
from ...utils import now_utc
from ..base import EnrichmentProvider, ProviderManifest, ProviderSecretField
from ._common import http_json, rate_guard

_URL = "https://app.netlas.io/api/host/{target}"


class NetlasProvider(EnrichmentProvider):
    name = "netlas"

    @classmethod
    def manifest(cls) -> ProviderManifest:
        return ProviderManifest(
            name=cls.name,
            display_name="Netlas",
            description=(
                "Internet-scan host profile for an IP or domain (DNS, WHOIS, "
                "related domains, exposure). Exposure context, not a reputation "
                "verdict."
            ),
            indicator_kinds=[IndicatorKind.IP, IndicatorKind.DOMAIN],
            config_key="use_netlas",
            secret_fields=[
                ProviderSecretField(
                    key="netlas_api_key",
                    label="Netlas API key",
                    required=True,
                    help="API key from your Netlas account (free community tier).",
                    help_link="https://app.netlas.io/profile/",
                ),
            ],
            keyless=False,
            free_tier="Free community tier (small daily quota)",
            docs_url="https://docs.netlas.io/",
            default_enabled=False,
            setup_steps=[
                "Create a free community account at app.netlas.io and copy the API "
                "key from your profile.",
                "Set TLSOC_NETLAS_API_KEY in .env (compose maps it to "
                "NETLAS_API_KEY), or paste it in this card (in-memory until "
                "restart).",
                "Flip this provider's toggle ON.",
            ],
            example=(
                "Shows the infrastructure around an indicator: the domain in your "
                "case sharing WHOIS and nameservers with fifty sibling domains "
                "registered the same week is a classic bulk-registered campaign "
                "footprint."
            ),
        )

    async def _lookup(self, value: str, kind: IndicatorKind) -> ProviderResult:
        key = self._secret("netlas_api_key")
        if not key:
            return ProviderResult(
                provider=self.name, indicator=value, indicator_kind=kind.value,
                ok=False, error="netlas: no api key",
            )
        await rate_guard(self.name)
        data = await http_json(
            _URL.format(target=quote(value.strip(), safe="")),
            headers={"X-API-Key": key, "Accept": "application/json"},
        )
        if not isinstance(data, dict) or not data:
            return ProviderResult(
                provider=self.name, indicator=value, indicator_kind=kind.value,
                score=0, malicious=False, tags=[], raw={"seen": False},
                ok=True, ts=now_utc(),
            )
        # Defensive extraction — the host profile shape varies by target type.
        dns_obj = data.get("dns") or {}
        a_records = [str(a) for a in (dns_obj.get("a") or [])] if isinstance(dns_obj, dict) else []
        related = data.get("related_domains") or data.get("domains") or []
        related_count = len(related) if isinstance(related, list) else 0
        whois = data.get("whois") or {}
        registrar = None
        if isinstance(whois, dict):
            registrar = ((whois.get("registrar") or {}) or {}).get("name") if isinstance(whois.get("registrar"), dict) else whois.get("registrar")
        has_profile = bool(a_records or related_count or registrar)
        # Exposure context (#3): 20 when Netlas has a real profile, else 0.
        score = 20 if has_profile else 0
        tags: list[str] = []
        if a_records:
            tags.append(f"resolves:{a_records[0]}")
        if related_count:
            tags.append(f"related_domains:{related_count}")
        return ProviderResult(
            provider=self.name, indicator=value, indicator_kind=kind.value,
            score=score, malicious=False, confidence=0.3,
            tags=tags,
            raw={
                "seen": True,
                "a_records": a_records[:10],
                "related_domain_count": related_count,
                "registrar": str(registrar)[:120] if registrar else None,
            },
            ok=True, ts=now_utc(),
        )
