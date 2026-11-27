"""Censys host enrichment provider (Round 3 Wave 2) — key-gated (id + secret).

Censys Search ``/v2/hosts/{ip}`` returns the services, autonomous-system and location
Censys last observed on a host. Like Shodan this is EXPOSURE context, not a verdict, so
the score is conservative (0, a small 20 bump only when services are present). Needs
BOTH a Censys API *id* and *secret* (HTTP Basic). Throttled to the free tier's
~1 req / 2.5 s. Every service/AS/location string is UNTRUSTED and fenced before a
prompt (#9).
"""

from __future__ import annotations

import base64

from ...constants import IndicatorKind
from ...models import ProviderResult
from ...utils import now_utc
from ..base import EnrichmentProvider, ProviderManifest, ProviderSecretField
from ._common import http_json, rate_guard

_URL = "https://search.censys.io/api/v2/hosts/{ip}"


class CensysProvider(EnrichmentProvider):
    name = "censys"

    @classmethod
    def manifest(cls) -> ProviderManifest:
        return ProviderManifest(
            name=cls.name,
            display_name="Censys",
            description=(
                "Host services / autonomous-system / location from Censys Search. "
                "Exposure context, not a reputation verdict."
            ),
            indicator_kinds=[IndicatorKind.IP],
            config_key="use_censys",
            secret_fields=[
                ProviderSecretField(
                    key="censys_api_id",
                    label="Censys API ID",
                    required=True,
                    help="API ID from your Censys account (Account → API).",
                    help_link="https://search.censys.io/account/api",
                ),
                ProviderSecretField(
                    key="censys_api_secret",
                    label="Censys API secret",
                    required=True,
                    help="API secret paired with the API ID.",
                    help_link="https://search.censys.io/account/api",
                ),
            ],
            keyless=False,
            free_tier="Free tier ~ 1 req / 2.5 s",
            docs_url="https://search.censys.io/api",
            default_enabled=False,
            setup_steps=[
                "Create a free account at search.censys.io and open Account → API.",
                "Copy BOTH the API ID and the API secret (they are used together as "
                "HTTP Basic auth).",
                "Set TLSOC_CENSYS_API_ID and TLSOC_CENSYS_API_SECRET in .env "
                "(compose maps them to CENSYS_API_ID / CENSYS_API_SECRET), or paste "
                "both in this card (in-memory until restart).",
                "Flip this provider's toggle ON.",
            ],
            example=(
                "Independent second opinion on host exposure: when a case hinges on "
                "whether an internal service was actually reachable from the "
                "internet, Censys' scan data confirms or refutes it without touching "
                "the host."
            ),
        )

    async def _lookup(self, value: str, kind: IndicatorKind) -> ProviderResult:
        api_id = self._secret("censys_api_id")
        api_secret = self._secret("censys_api_secret")
        if not api_id or not api_secret:
            return ProviderResult(
                provider=self.name, indicator=value, indicator_kind=kind.value,
                ok=False, error="censys: missing api id/secret",
            )
        await rate_guard(self.name)
        token = base64.b64encode(f"{api_id}:{api_secret}".encode()).decode()
        body = await http_json(
            _URL.format(ip=value),
            headers={"Authorization": f"Basic {token}", "Accept": "application/json"},
        )
        result = (body or {}).get("result", {}) if isinstance(body, dict) else {}
        if not result:
            return ProviderResult(
                provider=self.name, indicator=value, indicator_kind=kind.value,
                score=0, malicious=False, raw={"seen": False}, ok=True, ts=now_utc(),
            )
        services = result.get("services") or []
        ports = [str(s.get("port")) for s in services if isinstance(s, dict) and s.get("port")]
        svc_names = [str(s.get("service_name")) for s in services if isinstance(s, dict) and s.get("service_name")]
        autonomous = result.get("autonomous_system") or {}
        location = result.get("location") or {}
        country = location.get("country_code") or location.get("country") or None
        score = 20 if services else 0
        tags: list[str] = []
        if ports:
            tags.append(f"open_ports:{len(ports)}")
        tags.extend(svc_names[:10])
        return ProviderResult(
            provider=self.name, indicator=value, indicator_kind=kind.value,
            score=score, malicious=False, confidence=0.3,
            tags=tags,
            raw={
                "seen": True,
                "ports": ports,
                "services": svc_names[:25],
                "asn": autonomous.get("asn"),
                "as_name": autonomous.get("name"),
                "country": country,
            },
            ok=True, ts=now_utc(),
        )
