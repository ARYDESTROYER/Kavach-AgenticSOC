"""GreyNoise Community enrichment provider (Round 3 Wave 2).

The GreyNoise *Community* API answers "is this IP internet-background-noise / known-
benign / a known scanner?" for free with a key. We map its ``classification`` to a
0..100 score: ``malicious`` → 80, ``unknown`` → 40, ``benign`` → 0. ``riot``/``noise``
flags + the ``name`` become UNTRUSTED tags. Key-gated (``Secrets.greynoise_api_key``);
handles :class:`IndicatorKind.IP` only. ~50 lookups/week on the free Community tier —
honoured by the per-provider rate guard.
"""

from __future__ import annotations

from ...constants import IndicatorKind
from ...models import ProviderResult
from ...utils import now_utc
from ..base import EnrichmentProvider, ProviderManifest, ProviderSecretField
from ._common import http_json, rate_guard

_URL = "https://api.greynoise.io/v3/community/{ip}"
_SCORE = {"malicious": 80, "unknown": 40, "benign": 0}


class GreyNoiseProvider(EnrichmentProvider):
    name = "greynoise"

    @classmethod
    def manifest(cls) -> ProviderManifest:
        return ProviderManifest(
            name=cls.name,
            display_name="GreyNoise Community",
            description=(
                "Internet-background-noise / scanner classification. Tells you whether "
                "an IP is a known benign scanner, malicious, or unseen."
            ),
            indicator_kinds=[IndicatorKind.IP],
            config_key="use_greynoise",
            secret_fields=[
                ProviderSecretField(
                    key="greynoise_api_key",
                    label="GreyNoise API key",
                    required=True,
                    help="Free Community API key from your GreyNoise account.",
                    help_link="https://viz.greynoise.io/account/api-key",
                ),
            ],
            keyless=False,
            free_tier="~50 lookups/week (free Community key)",
            docs_url="https://docs.greynoise.io/reference/get_v3-community-ip",
            default_enabled=False,
            setup_steps=[
                "Create a free account at viz.greynoise.io and open Account → API key.",
                "Copy the Community API key (~50 lookups/week — cached results "
                "stretch it a long way).",
                "Set TLSOC_GREYNOISE_API_KEY in .env (compose maps it to "
                "GREYNOISE_API_KEY), or paste it in this card (in-memory until "
                "restart).",
                "Flip this provider's toggle ON — key-gated providers stay off until "
                "you opt in.",
            ],
            example=(
                "GreyNoise tells you an IP hammering your firewall is a known "
                "internet-wide scanner (benign background noise) rather than a "
                "targeted attacker — the single fastest way to close mass-scan "
                "false positives."
            ),
        )

    async def _lookup(self, value: str, kind: IndicatorKind) -> ProviderResult:
        key = self._secret("greynoise_api_key")
        if not key:
            return ProviderResult(
                provider=self.name, indicator=value, indicator_kind=kind.value,
                ok=False, error="greynoise: no api key",
            )
        await rate_guard(self.name)
        data = await http_json(
            _URL.format(ip=value),
            headers={"key": key, "Accept": "application/json"},
        )
        data = data if isinstance(data, dict) else {}
        classification = str(data.get("classification") or "unknown").lower()
        score = _SCORE.get(classification, 40)
        tags: list[str] = [f"classification:{classification}"]
        if data.get("noise"):
            tags.append("noise")
        if data.get("riot"):
            tags.append("riot")
        name = data.get("name")
        if name:
            tags.append(str(name))
        return ProviderResult(
            provider=self.name, indicator=value, indicator_kind=kind.value,
            score=score, malicious=score >= 50,
            confidence=0.7 if classification != "unknown" else 0.3,
            tags=tags,
            raw={
                "classification": classification,
                "noise": data.get("noise"),
                "riot": data.get("riot"),
                "name": name,
                "last_seen": data.get("last_seen"),
                "link": data.get("link"),
            },
            ok=True, ts=now_utc(),
        )
