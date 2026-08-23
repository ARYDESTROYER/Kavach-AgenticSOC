"""Maltiverse enrichment provider (Round 11) — key-gated, IP/domain/hash.

Maltiverse aggregates many blocklists into a single ``classification``
(malicious / suspicious / neutral / whitelist) plus the ``blacklist`` sources that
flagged the indicator. Classification map: malicious→90, suspicious→60,
neutral/whitelist→0. Key-gated (``Secrets.maltiverse_api_key``, sent as an
``Authorization: Bearer`` header). Endpoints: ``/ip/{ip}``, ``/hostname/{domain}``,
``/sample/{sha256}`` (file hashes: SHA-256 only — other lengths return a neutral
"unsupported" result). Blacklist descriptions are UNTRUSTED and fenced before a
prompt (#9).
"""

from __future__ import annotations

from urllib.parse import quote

from ...constants import IndicatorKind
from ...models import ProviderResult
from ...utils import now_utc
from ..base import EnrichmentProvider, ProviderManifest, ProviderSecretField
from ._common import http_json, rate_guard

_BASE = "https://api.maltiverse.com"

_CLASSIFICATION_SCORE = {"malicious": 90, "suspicious": 60, "neutral": 0, "whitelist": 0}


class MaltiverseProvider(EnrichmentProvider):
    name = "maltiverse"

    @classmethod
    def manifest(cls) -> ProviderManifest:
        return ProviderManifest(
            name=cls.name,
            display_name="Maltiverse",
            description=(
                "Aggregated blocklist verdicts for IPs, hostnames and SHA-256 "
                "samples: one malicious/suspicious/neutral classification plus the "
                "sources that flagged it."
            ),
            indicator_kinds=[IndicatorKind.IP, IndicatorKind.DOMAIN, IndicatorKind.FILE_HASH],
            config_key="use_maltiverse",
            secret_fields=[
                ProviderSecretField(
                    key="maltiverse_api_key",
                    label="Maltiverse API key",
                    required=True,
                    help="API key from your free Maltiverse community account.",
                    help_link="https://maltiverse.com/",
                ),
            ],
            keyless=False,
            free_tier="Free community account (rate-limited)",
            docs_url="https://app.swaggerhub.com/apis-docs/maltiverse/api/1.1.2",
            default_enabled=False,
            setup_steps=[
                "Create a free community account at maltiverse.com.",
                "Generate an API key from your profile page.",
                "Set TLSOC_MALTIVERSE_API_KEY in .env (compose maps it to "
                "MALTIVERSE_API_KEY), or paste it in this card (in-memory until "
                "restart).",
                "Flip this provider's toggle ON. File hashes must be SHA-256.",
            ],
            example=(
                "Instead of checking ten blocklists by hand, one call answers "
                "'malicious — listed by 4 sources including a botnet-C2 feed', with "
                "the source names attached as case evidence."
            ),
        )

    def _endpoint(self, value: str, kind: IndicatorKind) -> str | None:
        v = quote(value.strip(), safe="")
        if kind == IndicatorKind.IP:
            return f"{_BASE}/ip/{v}"
        if kind == IndicatorKind.DOMAIN:
            return f"{_BASE}/hostname/{v}"
        if kind == IndicatorKind.FILE_HASH:
            if len(value.strip()) != 64:
                return None  # sample endpoint is SHA-256 keyed
            return f"{_BASE}/sample/{v}"
        return None

    async def _lookup(self, value: str, kind: IndicatorKind) -> ProviderResult:
        key = self._secret("maltiverse_api_key")
        if not key:
            return ProviderResult(
                provider=self.name, indicator=value, indicator_kind=kind.value,
                ok=False, error="maltiverse: no api key",
            )
        endpoint = self._endpoint(value, kind)
        if endpoint is None:
            return ProviderResult(
                provider=self.name, indicator=value, indicator_kind=kind.value,
                score=0, malicious=False, tags=[], raw={"supported": False},
                ok=True, ts=now_utc(),
            )
        await rate_guard(self.name)
        data = await http_json(
            endpoint,
            headers={"Authorization": f"Bearer {key}", "Accept": "application/json"},
        )
        if not isinstance(data, dict) or not data.get("classification"):
            # 404 / unknown — Maltiverse has never catalogued it: clean miss.
            return ProviderResult(
                provider=self.name, indicator=value, indicator_kind=kind.value,
                score=0, malicious=False, tags=[], raw={"seen": False},
                ok=True, ts=now_utc(),
            )
        classification = str(data.get("classification") or "neutral").lower()
        score = _CLASSIFICATION_SCORE.get(classification, 0)
        sources = [
            str(b.get("source") or b.get("description"))
            for b in (data.get("blacklist") or [])
            if isinstance(b, dict) and (b.get("source") or b.get("description"))
        ]
        tags: list[str] = [f"classification:{classification}"]
        tags.extend(f"listed_by:{s}" for s in sources[:6])
        return ProviderResult(
            provider=self.name, indicator=value, indicator_kind=kind.value,
            score=score, malicious=score >= 50, confidence=0.75,
            tags=tags,
            raw={
                "seen": True,
                "classification": classification,
                "blacklist_sources": sources[:15],
                "country": data.get("country_code"),
                "tag": [str(t) for t in (data.get("tag") or [])][:10],
            },
            ok=True, ts=now_utc(),
        )
