"""APIVoid enrichment provider (Round 11) — key-gated, IP/domain/URL blacklists.

APIVoid aggregates ~90 public blacklist engines. Its ``iprep`` / ``domainbl`` /
``urlrep`` endpoints return ``blacklists.detections`` over ``engines_count`` — the
same detection-ratio shape as VirusTotal, mapped the same way (ratio × 100).
Key-gated (``Secrets.apivoid_api_key``, a ``?key=`` query param — ``http_json``
scrubs the query string from HTTP errors so the key never leaks, audit #5). Engine
names are UNTRUSTED and fenced before a prompt (#9).
"""

from __future__ import annotations

from ...constants import IndicatorKind
from ...models import ProviderResult
from ...utils import now_utc
from ..base import EnrichmentProvider, ProviderManifest, ProviderSecretField
from ._common import http_json, rate_guard

_ENDPOINTS = {
    IndicatorKind.IP: ("https://endpoint.apivoid.com/iprep/v1/pay-as-you-go/", "ip"),
    IndicatorKind.DOMAIN: ("https://endpoint.apivoid.com/domainbl/v1/pay-as-you-go/", "host"),
    IndicatorKind.URL: ("https://endpoint.apivoid.com/urlrep/v1/pay-as-you-go/", "url"),
}


class APIVoidProvider(EnrichmentProvider):
    name = "apivoid"

    @classmethod
    def manifest(cls) -> ProviderManifest:
        return ProviderManifest(
            name=cls.name,
            display_name="APIVoid",
            description=(
                "Blacklist aggregation for IPs, domains and URLs: how many of ~90 "
                "public blocklist engines flag the indicator (a VirusTotal-style "
                "detection ratio)."
            ),
            indicator_kinds=[IndicatorKind.IP, IndicatorKind.DOMAIN, IndicatorKind.URL],
            config_key="use_apivoid",
            secret_fields=[
                ProviderSecretField(
                    key="apivoid_api_key",
                    label="APIVoid API key",
                    required=True,
                    help="API key from your APIVoid account (credit-based; free signup credits).",
                    help_link="https://app.apivoid.com/",
                ),
            ],
            keyless=False,
            free_tier="Credit-based (free signup credits; then pay-as-you-go)",
            docs_url="https://docs.apivoid.com/",
            default_enabled=False,
            setup_steps=[
                "Create an account at app.apivoid.com (new accounts get free "
                "credits) and copy the API key.",
                "Set TLSOC_APIVOID_API_KEY in .env (compose maps it to "
                "APIVOID_API_KEY), or paste it in this card (in-memory until "
                "restart).",
                "Flip this provider's toggle ON — one key covers IP, domain and URL "
                "reputation.",
            ],
            example=(
                "A callback domain flagged by 12 of 80 blacklist engines (with the "
                "engine names as tags) corroborates a weak EDR signal — one engine "
                "may be a false positive, twelve rarely are."
            ),
        )

    async def _lookup(self, value: str, kind: IndicatorKind) -> ProviderResult:
        key = self._secret("apivoid_api_key")
        if not key:
            return ProviderResult(
                provider=self.name, indicator=value, indicator_kind=kind.value,
                ok=False, error="apivoid: no api key",
            )
        endpoint = _ENDPOINTS.get(kind)
        if endpoint is None:
            raise ValueError(f"apivoid: unsupported kind {kind.value}")
        url, param = endpoint
        await rate_guard(self.name)
        data = await http_json(url, params={"key": key, param: value})
        data = data if isinstance(data, dict) else {}
        if data.get("error"):
            # APIVoid answers 200 with an "error" field — keep it generic.
            return ProviderResult(
                provider=self.name, indicator=value, indicator_kind=kind.value,
                ok=False, error="apivoid: query rejected",
            )
        report = ((data.get("data") or {}).get("report") or {})
        bl = report.get("blacklists") or report.get("domain_blacklist") or {}
        # iprep/urlrep: {"detections": N, "engines_count": M}; domainbl carries a
        # list of engines with a "detected" flag.
        detections = bl.get("detections")
        engines_count = bl.get("engines_count")
        if detections is None and isinstance(bl.get("engines"), list):
            engines = [e for e in bl["engines"] if isinstance(e, dict)]
            detections = sum(1 for e in engines if e.get("detected"))
            engines_count = len(engines)
        try:
            det = int(detections or 0)
            total = int(engines_count or 0)
        except (TypeError, ValueError):
            det, total = 0, 0
        score = int(round(det / total * 100)) if total else 0
        detected_names: list[str] = []
        engines_any = bl.get("engines")
        if isinstance(engines_any, list):
            detected_names = [
                str(e.get("engine") or e.get("name"))
                for e in engines_any
                if isinstance(e, dict) and e.get("detected") and (e.get("engine") or e.get("name"))
            ]
        return ProviderResult(
            provider=self.name, indicator=value, indicator_kind=kind.value,
            # Detection ratio maps directly, same shape as VirusTotal.
            score=score, malicious=score >= 50, confidence=0.7 if total else 0.2,
            tags=[f"detections:{det}/{total}"] + detected_names[:8],
            raw={
                "detections": det,
                "engines_count": total,
                "detected_engines": detected_names[:20],
            },
            ok=True, ts=now_utc(),
        )
