"""urlscan.io enrichment provider (Round 3 Wave 2) — key-gated, URL/domain.

urlscan.io's ``/api/v1/search/?q=`` returns prior scans of a URL or domain plus any
verdict an existing scan carries. We score on the worst malicious verdict found
(``verdicts.overall.malicious`` → 80, ``score`` is otherwise context). Key-gated
(``Secrets.urlscan_api_key``, the ``API-Key`` header). Every page title / verdict
category is UNTRUSTED and fenced before a prompt (#9).
"""

from __future__ import annotations

from ...constants import IndicatorKind
from ...models import ProviderResult
from ...utils import now_utc
from ..base import EnrichmentProvider, ProviderManifest, ProviderSecretField
from ._common import http_json, rate_guard

_SEARCH_URL = "https://urlscan.io/api/v1/search/"


class URLScanProvider(EnrichmentProvider):
    name = "urlscan"

    @classmethod
    def manifest(cls) -> ProviderManifest:
        return ProviderManifest(
            name=cls.name,
            display_name="urlscan.io",
            description=(
                "Prior urlscan.io scans + verdicts for a URL or domain. A malicious "
                "verdict scores 80; otherwise scan context."
            ),
            indicator_kinds=[IndicatorKind.URL, IndicatorKind.DOMAIN],
            config_key="use_urlscan",
            secret_fields=[
                ProviderSecretField(
                    key="urlscan_api_key",
                    label="urlscan.io API key",
                    required=True,
                    help="API key from your urlscan.io account (Settings → API).",
                    help_link="https://urlscan.io/user/profile/",
                ),
            ],
            keyless=False,
            free_tier="Free tier (rate-limited) with an account key",
            docs_url="https://urlscan.io/docs/api/",
            default_enabled=False,
            setup_steps=[
                "Create a free account at urlscan.io and open Settings → API.",
                "Create an API key (the free tier is rate-limited but ample for "
                "triage lookups).",
                "Set TLSOC_URLSCAN_API_KEY in .env (compose maps it to "
                "URLSCAN_API_KEY), or paste it in this card (in-memory until "
                "restart).",
                "Flip this provider's toggle ON.",
            ],
            example=(
                "Answers 'what does this link actually do?' from prior sandboxed "
                "scans: a URL whose last urlscan verdict is 'malicious — phishing' "
                "closes the loop on a suspicious-email case without anyone clicking "
                "it."
            ),
        )

    async def _lookup(self, value: str, kind: IndicatorKind) -> ProviderResult:
        key = self._secret("urlscan_api_key")
        if not key:
            return ProviderResult(
                provider=self.name, indicator=value, indicator_kind=kind.value,
                ok=False, error="urlscan: no api key",
            )
        await rate_guard(self.name)
        field = "page.url" if kind == IndicatorKind.URL else "domain"
        body = await http_json(
            _SEARCH_URL,
            params={"q": f'{field}:"{value}"', "size": "10"},
            headers={"API-Key": key, "Accept": "application/json"},
        )
        body = body if isinstance(body, dict) else {}
        results = body.get("results") or []
        total = int(body.get("total") or len(results) or 0)
        malicious = False
        verdict_tags: list[str] = []
        for r in results if isinstance(results, list) else []:
            if not isinstance(r, dict):
                continue
            verdicts = ((r.get("verdicts") or {}).get("overall") or {})
            if verdicts.get("malicious"):
                malicious = True
                for cat in (verdicts.get("categories") or [])[:3]:
                    verdict_tags.append(str(cat))
        score = 80 if malicious else (10 if total else 0)
        tags: list[str] = [f"scans:{total}"]
        if malicious:
            tags.append("urlscan_malicious")
        tags.extend(verdict_tags[:5])
        return ProviderResult(
            provider=self.name, indicator=value, indicator_kind=kind.value,
            score=score, malicious=malicious, confidence=0.7 if malicious else 0.3,
            tags=tags,
            raw={
                "total_scans": total,
                "malicious": malicious,
                "categories": verdict_tags[:10],
            },
            ok=True, ts=now_utc(),
        )
