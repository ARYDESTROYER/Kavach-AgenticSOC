"""BinaryEdge host enrichment provider (Round 3 Wave 2) — key-gated.

BinaryEdge ``/v2/query/ip/{ip}`` returns the ports/services BinaryEdge has scanned on a
host. Exposure context, not a verdict — conservative score (0, a small 20 bump when
ports are present). Key-gated (``Secrets.binaryedge_api_key``, the ``X-Key`` header);
IP only. Every port/service string is UNTRUSTED and fenced before a prompt (#9).
"""

from __future__ import annotations

from ...constants import IndicatorKind
from ...models import ProviderResult
from ...utils import now_utc
from ..base import EnrichmentProvider, ProviderManifest, ProviderSecretField
from ._common import http_json, rate_guard

_URL = "https://api.binaryedge.io/v2/query/ip/{ip}"


class BinaryEdgeProvider(EnrichmentProvider):
    name = "binaryedge"

    @classmethod
    def manifest(cls) -> ProviderManifest:
        return ProviderManifest(
            name=cls.name,
            display_name="BinaryEdge",
            description=(
                "Host ports/services from BinaryEdge's internet scan data. Exposure "
                "context, not a reputation verdict."
            ),
            indicator_kinds=[IndicatorKind.IP],
            config_key="use_binaryedge",
            secret_fields=[
                ProviderSecretField(
                    key="binaryedge_api_key",
                    label="BinaryEdge API key",
                    required=True,
                    help="API key from your BinaryEdge account.",
                    help_link="https://app.binaryedge.io/account/api",
                ),
            ],
            keyless=False,
            free_tier="Free tier ~ 250 requests/month",
            docs_url="https://docs.binaryedge.io/api-v2/",
            default_enabled=False,
            setup_steps=[
                "Sign up at app.binaryedge.io (free tier: ~250 requests/month) and "
                "open Account → API.",
                "Set TLSOC_BINARYEDGE_API_KEY in .env (compose maps it to "
                "BINARYEDGE_API_KEY), or paste it in this card (in-memory until "
                "restart).",
                "Flip this provider's toggle ON.",
            ],
            example=(
                "A third scan-data angle on an IP's open ports and services — useful "
                "when Shodan/Censys disagree or have stale data for the address in "
                "your case."
            ),
        )

    async def _lookup(self, value: str, kind: IndicatorKind) -> ProviderResult:
        key = self._secret("binaryedge_api_key")
        if not key:
            return ProviderResult(
                provider=self.name, indicator=value, indicator_kind=kind.value,
                ok=False, error="binaryedge: no api key",
            )
        await rate_guard(self.name)
        data = await http_json(
            _URL.format(ip=value),
            headers={"X-Key": key, "Accept": "application/json"},
        )
        data = data if isinstance(data, dict) else {}
        events = data.get("events") or []
        ports = sorted({str(e.get("port")) for e in events if isinstance(e, dict) and e.get("port")})
        total = data.get("total")
        score = 20 if ports else 0
        tags: list[str] = []
        if ports:
            tags.append(f"open_ports:{len(ports)}")
        return ProviderResult(
            provider=self.name, indicator=value, indicator_kind=kind.value,
            score=score, malicious=False, confidence=0.3,
            tags=tags,
            raw={
                "seen": bool(events),
                "ports": list(ports)[:50],
                "total": total,
            },
            ok=True, ts=now_utc(),
        )
