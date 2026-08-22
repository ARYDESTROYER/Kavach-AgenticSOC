"""Robtex enrichment provider (Round 11) — KEYLESS, default-OFF.

Robtex's free API (``freeapi.robtex.com/ipquery/{ip}``) returns passive-DNS and
routing context for an IP: forward/reverse DNS history, the announcing AS and BGP
route. PURE context — score is ALWAYS 0 and ``malicious`` always False (#3); its
value is the pivot data (what domains have pointed at this IP). The free tier is
heavily rate-limited and can be slow, hence default-OFF. Keyless ⇒
``http_json_soft`` (advisory; errors degrade to no-data). Every hostname is
UNTRUSTED and fenced before a prompt (#9).
"""

from __future__ import annotations

from ...constants import IndicatorKind
from ...models import ProviderResult
from ...utils import now_utc
from ..base import EnrichmentProvider, ProviderManifest
from ._common import http_json_soft, rate_guard

_URL = "https://freeapi.robtex.com/ipquery/{ip}"


class RobtexProvider(EnrichmentProvider):
    name = "robtex"

    @classmethod
    def manifest(cls) -> ProviderManifest:
        return ProviderManifest(
            name=cls.name,
            display_name="Robtex",
            description=(
                "Passive-DNS + AS/BGP context for an IP (which domains point or "
                "pointed at it, who announces it). Pure pivot context — never a "
                "verdict."
            ),
            indicator_kinds=[IndicatorKind.IP],
            config_key="use_robtex",
            secret_fields=[],
            keyless=True,
            free_tier="Keyless free API (heavily rate-limited; can be slow)",
            docs_url="https://freeapi.robtex.com/",
            default_enabled=False,
            setup_steps=[
                "Nothing to sign up for — the free API is keyless.",
                "Flip this provider's toggle ON (default OFF because the free tier "
                "is slow and tightly rate-limited).",
                "Requires outbound HTTPS to freeapi.robtex.com.",
            ],
            example=(
                "Passive DNS shows that the C2 IP in your case also hosted "
                "'invoice-portal-secure.example' last month — pivot data that links "
                "two otherwise unrelated cases into one campaign."
            ),
        )

    async def _lookup(self, value: str, kind: IndicatorKind) -> ProviderResult:
        await rate_guard(self.name)
        data = await http_json_soft(_URL.format(ip=value), timeout=4.0)
        if not isinstance(data, dict):
            return ProviderResult(
                provider=self.name, indicator=value, indicator_kind=kind.value,
                score=0, malicious=False, tags=[], raw={"seen": False},
                ok=True, ts=now_utc(),
            )
        pas = data.get("pas") or []      # passive DNS: domains → this IP
        pash = data.get("pash") or []    # passive DNS history
        act = data.get("act") or []      # active forward DNS
        domains: list[str] = []
        for row in list(pas) + list(pash) + list(act):
            if isinstance(row, dict) and row.get("o"):
                domains.append(str(row["o"]))
        seen_domains = sorted(set(domains))
        tags: list[str] = []
        if seen_domains:
            tags.append(f"pdns_domains:{len(seen_domains)}")
        if data.get("as"):
            tags.append(f"as:{data.get('as')}")
        return ProviderResult(
            provider=self.name, indicator=value, indicator_kind=kind.value,
            # Pure context: ALWAYS 0 / non-malicious (#3-safe).
            score=0, malicious=False, confidence=0.2,
            tags=tags,
            raw={
                "seen": True,
                "asn": data.get("as"),
                "as_name": data.get("asname"),
                "bgp_route": data.get("bgproute"),
                "country": data.get("country"),
                "pdns_domains": seen_domains[:25],
            },
            ok=True, ts=now_utc(),
        )
