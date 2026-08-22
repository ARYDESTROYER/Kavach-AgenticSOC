"""IBM X-Force Exchange enrichment provider (Round 3 Wave 2) — key-gated, multi-indicator.

X-Force ``/ipr/{ip}`` (and ``/url/{value}``, ``/malware/{hash}``) returns a 1..10 risk
``score`` for IPs/URLs/hashes plus the categories X-Force assigns. We map the 1..10
band onto 0..100 (``x10``). Auth is HTTP-Basic with an API *key* + *password*
(``Secrets.xforce_api_key`` / ``xforce_api_password``). Every category string is
UNTRUSTED and fenced before a prompt (#9).
"""

from __future__ import annotations

import base64

from ...constants import IndicatorKind
from ...models import ProviderResult
from ...utils import now_utc
from ..base import EnrichmentProvider, ProviderManifest, ProviderSecretField
from ._common import http_json, rate_guard

_BASE = "https://api.xforce.ibmcloud.com"


def _path_for(kind: IndicatorKind, value: str) -> str | None:
    if kind == IndicatorKind.IP:
        return f"/ipr/{value}"
    if kind == IndicatorKind.URL or kind == IndicatorKind.DOMAIN:
        return f"/url/{value}"
    if kind == IndicatorKind.FILE_HASH:
        return f"/malware/{value}"
    return None


class XForceProvider(EnrichmentProvider):
    name = "xforce"

    @classmethod
    def manifest(cls) -> ProviderManifest:
        return ProviderManifest(
            name=cls.name,
            display_name="IBM X-Force Exchange",
            description=(
                "IBM X-Force risk score (1..10 → 0..100) + categories for IPs, URLs, "
                "domains and file hashes."
            ),
            indicator_kinds=[
                IndicatorKind.IP, IndicatorKind.URL, IndicatorKind.DOMAIN, IndicatorKind.FILE_HASH,
            ],
            config_key="use_xforce",
            secret_fields=[
                ProviderSecretField(
                    key="xforce_api_key",
                    label="X-Force API key",
                    required=True,
                    help="API key from your IBM X-Force Exchange account.",
                    help_link="https://exchange.xforce.ibmcloud.com/settings/api",
                ),
                ProviderSecretField(
                    key="xforce_api_password",
                    label="X-Force API password",
                    required=True,
                    help="API password paired with the API key.",
                    help_link="https://exchange.xforce.ibmcloud.com/settings/api",
                ),
            ],
            keyless=False,
            free_tier="Free X-Force account (rate-limited)",
            docs_url="https://api.xforce.ibmcloud.com/doc/",
            default_enabled=False,
            setup_steps=[
                "Create a free account at exchange.xforce.ibmcloud.com and open "
                "Settings → API access.",
                "Generate the API key AND API password pair (both are required — "
                "they form HTTP Basic auth).",
                "Set TLSOC_XFORCE_API_KEY and TLSOC_XFORCE_API_PASSWORD in .env "
                "(compose maps them to XFORCE_API_KEY / XFORCE_API_PASSWORD), or "
                "paste both in this card (in-memory until restart).",
                "Flip this provider's toggle ON.",
            ],
            example=(
                "IBM's 1..10 risk band plus category labels ('Botnet Command and "
                "Control Server') gives a second vendor-grade verdict when "
                "VirusTotal and the community feeds disagree."
            ),
        )

    async def _lookup(self, value: str, kind: IndicatorKind) -> ProviderResult:
        key = self._secret("xforce_api_key")
        password = self._secret("xforce_api_password")
        if not key or not password:
            return ProviderResult(
                provider=self.name, indicator=value, indicator_kind=kind.value,
                ok=False, error="xforce: missing api key/password",
            )
        path = _path_for(kind, value)
        if path is None:
            return ProviderResult(
                provider=self.name, indicator=value, indicator_kind=kind.value,
                ok=False, error=f"xforce: unsupported kind {kind.value}",
            )
        await rate_guard(self.name)
        token = base64.b64encode(f"{key}:{password}".encode()).decode()
        data = await http_json(
            f"{_BASE}{path}",
            headers={"Authorization": f"Basic {token}", "Accept": "application/json"},
        )
        data = data if isinstance(data, dict) else {}
        # IP responses nest the score under "ip"/score; url under "result".score.
        result_obj = data.get("result") or data
        raw_score = result_obj.get("score")
        if raw_score is None:
            raw_score = data.get("score")
        try:
            band = float(raw_score) if raw_score is not None else 0.0
        except (TypeError, ValueError):
            band = 0.0
        score = int(max(0.0, min(100.0, band * 10.0)))
        cats_obj = result_obj.get("cats") or data.get("cats") or {}
        categories = list(cats_obj.keys()) if isinstance(cats_obj, dict) else []
        tags: list[str] = [f"xforce_score:{band:g}"]
        tags.extend(str(c) for c in categories[:5])
        return ProviderResult(
            provider=self.name, indicator=value, indicator_kind=kind.value,
            score=score, malicious=score >= 50, confidence=min(1.0, band / 10.0),
            tags=tags,
            raw={
                "xforce_score": band,
                "categories": [str(c) for c in categories[:15]],
                "geo": (result_obj.get("geo") or {}).get("country") if isinstance(result_obj.get("geo"), dict) else None,
                "reason": result_obj.get("reason"),
            },
            ok=True, ts=now_utc(),
        )
