"""ipdata enrichment provider (Round 11) — key-gated, IP threat + geo context.

ipdata's ``/{ip}?api-key=`` returns a ``threat`` object (``is_known_attacker`` /
``is_known_abuser`` from open blocklists, Tor/proxy/anonymity flags, the blocklists
that matched) plus geo/ASN. Mapping: a blocklisted known attacker/abuser → 60
(``malicious=True`` — it IS on curated blocklists); anonymity-only (Tor/proxy/VPN)
→ 40, context; otherwise 0. Key-gated (``Secrets.ipdata_api_key``, a query param —
``http_json`` scrubs the query string from HTTP errors so the key never leaks,
audit #5). Blocklist names are UNTRUSTED and fenced before a prompt (#9).
"""

from __future__ import annotations

from urllib.parse import quote

from ...constants import IndicatorKind
from ...models import ProviderResult
from ...utils import now_utc
from ..base import EnrichmentProvider, ProviderManifest, ProviderSecretField
from ._common import http_json, rate_guard

_URL = "https://api.ipdata.co/{ip}"


class IPDataProvider(EnrichmentProvider):
    name = "ipdata"

    @classmethod
    def manifest(cls) -> ProviderManifest:
        return ProviderManifest(
            name=cls.name,
            display_name="ipdata",
            description=(
                "Per-IP threat intel (known attacker/abuser from open blocklists, "
                "Tor/proxy/anonymity flags) plus geo and ASN in one call."
            ),
            indicator_kinds=[IndicatorKind.IP],
            config_key="use_ipdata",
            secret_fields=[
                ProviderSecretField(
                    key="ipdata_api_key",
                    label="ipdata API key",
                    required=True,
                    help="Free API key from ipdata.co (1,500 requests/day).",
                    help_link="https://ipdata.co/sign-up.html",
                ),
            ],
            keyless=False,
            free_tier="1,500 requests/day (free key)",
            docs_url="https://docs.ipdata.co/",
            default_enabled=False,
            setup_steps=[
                "Sign up free at ipdata.co (1,500 requests/day) and copy the API "
                "key from the dashboard.",
                "Set TLSOC_IPDATA_API_KEY in .env (compose maps it to "
                "IPDATA_API_KEY), or paste it in this card (in-memory until "
                "restart).",
                "Flip this provider's toggle ON.",
            ],
            example=(
                "One lookup says the source IP 'is_known_attacker' on two open "
                "blocklists AND is a Tor exit in Romania — reputation, anonymity "
                "and geo in a single row of the case evidence."
            ),
        )

    async def _lookup(self, value: str, kind: IndicatorKind) -> ProviderResult:
        key = self._secret("ipdata_api_key")
        if not key:
            return ProviderResult(
                provider=self.name, indicator=value, indicator_kind=kind.value,
                ok=False, error="ipdata: no api key",
            )
        await rate_guard(self.name)
        data = await http_json(
            _URL.format(ip=quote(value, safe="")),
            params={"api-key": key},
        )
        data = data if isinstance(data, dict) else {}
        threat = data.get("threat") or {}
        known_bad = bool(threat.get("is_known_attacker") or threat.get("is_known_abuser"))
        anonymous = bool(
            threat.get("is_tor") or threat.get("is_proxy") or threat.get("is_anonymous")
        )
        blocklists = [
            str(b.get("name")) for b in (threat.get("blocklists") or [])
            if isinstance(b, dict) and b.get("name")
        ]
        if known_bad:
            score = 60
        elif anonymous:
            score = 40
        else:
            score = 0
        tags: list[str] = []
        if threat.get("is_known_attacker"):
            tags.append("known_attacker")
        if threat.get("is_known_abuser"):
            tags.append("known_abuser")
        if threat.get("is_tor"):
            tags.append("tor")
        if threat.get("is_proxy"):
            tags.append("proxy")
        tags.extend(f"blocklist:{b}" for b in blocklists[:5])
        return ProviderResult(
            provider=self.name, indicator=value, indicator_kind=kind.value,
            score=score, malicious=known_bad, confidence=0.6 if known_bad else 0.3,
            tags=tags,
            raw={
                "known_attacker": bool(threat.get("is_known_attacker")),
                "known_abuser": bool(threat.get("is_known_abuser")),
                "anonymous": anonymous,
                "blocklists": blocklists[:10],
                "country": data.get("country_code"),
                "asn": (data.get("asn") or {}).get("asn"),
                "org": (data.get("asn") or {}).get("name"),
            },
            ok=True, ts=now_utc(),
        )
