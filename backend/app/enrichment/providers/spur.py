"""Spur enrichment provider (Round 3 Wave 2) — key-gated, IP anonymity context.

Spur's ``/v2/context/{ip}`` reports whether an IP is part of a VPN / proxy / residential-
proxy / Tor anonymisation network and how many concurrent clients it carries. This is
ANONYMITY/INFRASTRUCTURE context rather than a malice verdict, so the score is modest:
0 by default, 40 when the IP is on an anonymisation network (so it informs but does not
alone clear the 50 malicious cut). Key-gated (``Secrets.spur_api_key``, the ``Token``
header). Every infrastructure label is UNTRUSTED and fenced before a prompt (#9).
"""

from __future__ import annotations

from ...constants import IndicatorKind
from ...models import ProviderResult
from ...utils import now_utc
from ..base import EnrichmentProvider, ProviderManifest, ProviderSecretField
from ._common import http_json, rate_guard

_URL = "https://api.spur.us/v2/context/{ip}"


class SpurProvider(EnrichmentProvider):
    name = "spur"

    @classmethod
    def manifest(cls) -> ProviderManifest:
        return ProviderManifest(
            name=cls.name,
            display_name="Spur",
            description=(
                "VPN / proxy / residential-proxy / Tor anonymity context for an IP. "
                "Infrastructure context, not a malice verdict."
            ),
            indicator_kinds=[IndicatorKind.IP],
            config_key="use_spur",
            secret_fields=[
                ProviderSecretField(
                    key="spur_api_key",
                    label="Spur API token",
                    required=True,
                    help="API token from your Spur account.",
                    help_link="https://spur.us/",
                ),
            ],
            keyless=False,
            free_tier="Commercial; token required",
            docs_url="https://docs.spur.us/",
            default_enabled=False,
            setup_steps=[
                "Request a Spur account/token at spur.us (commercial; trials "
                "available).",
                "Set TLSOC_SPUR_API_KEY in .env (compose maps it to SPUR_API_KEY), "
                "or paste the token in this card (in-memory until restart).",
                "Flip this provider's toggle ON.",
            ],
            example=(
                "Flags residential-proxy / VPN / Tor exits: a credential-stuffing "
                "login from a residential-proxy IP is not mistaken for the "
                "road-warrior VP on hotel Wi-Fi — and vice versa."
            ),
        )

    async def _lookup(self, value: str, kind: IndicatorKind) -> ProviderResult:
        key = self._secret("spur_api_key")
        if not key:
            return ProviderResult(
                provider=self.name, indicator=value, indicator_kind=kind.value,
                ok=False, error="spur: no api key",
            )
        await rate_guard(self.name)
        data = await http_json(
            _URL.format(ip=value),
            headers={"Token": key, "Accept": "application/json"},
        )
        data = data if isinstance(data, dict) else {}
        client = data.get("client") or {}
        tunnels = data.get("tunnels") or []
        tunnel_types = [
            str(t.get("type")) for t in tunnels if isinstance(t, dict) and t.get("type")
        ]
        anon = bool(tunnel_types) or bool(client.get("proxies"))
        score = 40 if anon else 0
        tags: list[str] = []
        for tt in tunnel_types[:5]:
            tags.append(f"tunnel:{tt}")
        if client.get("concentration"):
            tags.append("residential_proxy")
        return ProviderResult(
            provider=self.name, indicator=value, indicator_kind=kind.value,
            score=score, malicious=False, confidence=0.4 if anon else 0.2,
            tags=tags,
            raw={
                "tunnels": tunnel_types[:10],
                "client_count": client.get("count"),
                "client_types": [str(t) for t in (client.get("types") or [])][:10],
                "infrastructure": data.get("infrastructure"),
                "country": (data.get("geo") or {}).get("country"),
            },
            ok=True, ts=now_utc(),
        )
