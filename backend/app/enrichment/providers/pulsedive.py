"""Pulsedive enrichment provider (Round 3 Wave 2) — key-gated, multi-indicator.

Pulsedive ``/api/info.php?indicator=`` returns a risk band (``none``/``low``/
``medium``/``high``/``critical``/``unknown``) for IPs, domains, URLs and file hashes,
plus the threats/feeds it appears in. We map the risk band onto 0..100. Key-gated
(``Secrets.pulsedive_api_key``). Every threat/feed name + the risk band is UNTRUSTED
text and is fenced before a prompt (#9).
"""

from __future__ import annotations

from ...constants import IndicatorKind
from ...models import ProviderResult
from ...utils import now_utc
from ..base import EnrichmentProvider, ProviderManifest, ProviderSecretField
from ._common import http_json, rate_guard

_URL = "https://pulsedive.com/api/info.php"
_RISK = {"none": 0, "low": 25, "medium": 50, "high": 75, "critical": 95, "unknown": 30}


class PulsediveProvider(EnrichmentProvider):
    name = "pulsedive"

    @classmethod
    def manifest(cls) -> ProviderManifest:
        return ProviderManifest(
            name=cls.name,
            display_name="Pulsedive",
            description=(
                "Risk band (none..critical) + threats/feeds for IPs, domains, URLs and "
                "file hashes, mapped onto a 0..100 score."
            ),
            indicator_kinds=[
                IndicatorKind.IP, IndicatorKind.DOMAIN, IndicatorKind.URL, IndicatorKind.FILE_HASH,
            ],
            config_key="use_pulsedive",
            secret_fields=[
                ProviderSecretField(
                    key="pulsedive_api_key",
                    label="Pulsedive API key",
                    required=True,
                    help="Free API key from your Pulsedive account.",
                    help_link="https://pulsedive.com/api/",
                ),
            ],
            keyless=False,
            free_tier="Free tier ~ 30 requests/min",
            docs_url="https://pulsedive.com/api/",
            default_enabled=False,
            setup_steps=[
                "Create a free account at pulsedive.com and copy the API key from "
                "your account page.",
                "Set TLSOC_PULSEDIVE_API_KEY in .env (compose maps it to "
                "PULSEDIVE_API_KEY), or paste it in this card (in-memory until "
                "restart).",
                "Flip this provider's toggle ON.",
            ],
            example=(
                "One call answers 'has any threat feed ever listed this?': a domain "
                "rated 'critical' with the feeds that flagged it gives the "
                "investigator a ready-made risk band across IPs, domains, URLs and "
                "hashes."
            ),
        )

    async def _lookup(self, value: str, kind: IndicatorKind) -> ProviderResult:
        key = self._secret("pulsedive_api_key")
        if not key:
            return ProviderResult(
                provider=self.name, indicator=value, indicator_kind=kind.value,
                ok=False, error="pulsedive: no api key",
            )
        await rate_guard(self.name)
        data = await http_json(
            _URL,
            params={"indicator": value, "pretty": "0", "key": key},
        )
        data = data if isinstance(data, dict) else {}
        # An unknown indicator comes back with an ``error`` field — a clean miss.
        if data.get("error") and not data.get("risk"):
            return ProviderResult(
                provider=self.name, indicator=value, indicator_kind=kind.value,
                score=0, malicious=False, raw={"seen": False}, ok=True, ts=now_utc(),
            )
        risk = str(data.get("risk") or "unknown").lower()
        score = _RISK.get(risk, 30)
        threats = [str(t.get("name")) for t in (data.get("threats") or []) if isinstance(t, dict) and t.get("name")]
        feeds = [str(f.get("name")) for f in (data.get("feeds") or []) if isinstance(f, dict) and f.get("name")]
        tags: list[str] = [f"risk:{risk}"]
        tags.extend(threats[:5])
        return ProviderResult(
            provider=self.name, indicator=value, indicator_kind=kind.value,
            score=score, malicious=score >= 50,
            confidence=0.6 if risk not in ("unknown", "none") else 0.3,
            tags=tags,
            raw={
                "risk": risk,
                "threats": threats[:10],
                "feeds": feeds[:10],
            },
            ok=True, ts=now_utc(),
        )
