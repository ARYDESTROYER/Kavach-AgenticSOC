"""CrowdSec CTI enrichment provider (Round 11) — key-gated, IP reputation.

CrowdSec's CTI ``/v2/smoke/{ip}`` aggregates the crowd's behavioural reports into a
graded reputation: a ``reputation`` label (malicious/suspicious/known/safe/unknown),
0..5 ``scores.overall.total``, attack ``behaviors`` and a background-noise score.
GRADED reputation → direct 0..100 map: the label anchors the score (malicious→85,
suspicious→60), otherwise ``overall.total`` × 20. Key-gated
(``Secrets.crowdsec_api_key``, the ``x-api-key`` header); a 404 is a clean miss
(the crowd has never reported the IP). Every behaviour label is UNTRUSTED and
fenced before a prompt (#9).
"""

from __future__ import annotations

from ...constants import IndicatorKind
from ...models import ProviderResult
from ...utils import now_utc
from ..base import EnrichmentProvider, ProviderManifest, ProviderSecretField
from ._common import http_json, rate_guard

_URL = "https://cti.api.crowdsec.net/v2/smoke/{ip}"

_REPUTATION_FLOOR = {"malicious": 85, "suspicious": 60}


class CrowdSecProvider(EnrichmentProvider):
    name = "crowdsec"

    @classmethod
    def manifest(cls) -> ProviderManifest:
        return ProviderManifest(
            name=cls.name,
            display_name="CrowdSec CTI",
            description=(
                "Crowd-sourced behavioural IP reputation: a malicious/suspicious "
                "label, 0..5 aggressiveness scores, attack behaviours and "
                "background-noise rating."
            ),
            indicator_kinds=[IndicatorKind.IP],
            config_key="use_crowdsec",
            secret_fields=[
                ProviderSecretField(
                    key="crowdsec_api_key",
                    label="CrowdSec CTI API key",
                    required=True,
                    help="Free CTI API key from the CrowdSec console (limited queries/day).",
                    help_link="https://app.crowdsec.net/",
                ),
            ],
            keyless=False,
            free_tier="Free CTI key (small daily query quota)",
            docs_url="https://docs.crowdsec.net/u/cti_api/getting_started/",
            default_enabled=False,
            setup_steps=[
                "Create a free account at app.crowdsec.net and open Settings → CTI "
                "API keys.",
                "Create a CTI key (the free tier allows a small number of queries "
                "per day — the Redis cache stretches it).",
                "Set TLSOC_CROWDSEC_API_KEY in .env (compose maps it to "
                "CROWDSEC_API_KEY), or paste it in this card (in-memory until "
                "restart).",
                "Flip this provider's toggle ON.",
            ],
            example=(
                "CrowdSec reports the IP behind a web-app alert as 'malicious' with "
                "behaviours 'http:bruteforce, http:scan' seen by hundreds of other "
                "installations this week — crowd confirmation that this is an "
                "active attacker, not a one-off."
            ),
        )

    async def _lookup(self, value: str, kind: IndicatorKind) -> ProviderResult:
        key = self._secret("crowdsec_api_key")
        if not key:
            return ProviderResult(
                provider=self.name, indicator=value, indicator_kind=kind.value,
                ok=False, error="crowdsec: no api key",
            )
        await rate_guard(self.name)
        data = await http_json(
            _URL.format(ip=value),
            headers={"x-api-key": key, "Accept": "application/json"},
        )
        if not isinstance(data, dict):
            # 404 — the crowd has never reported this IP: clean miss.
            return ProviderResult(
                provider=self.name, indicator=value, indicator_kind=kind.value,
                score=0, malicious=False, tags=[], raw={"seen": False},
                ok=True, ts=now_utc(),
            )
        reputation = str(data.get("reputation") or "unknown")
        overall = ((data.get("scores") or {}).get("overall") or {})
        try:
            total = float(overall.get("total") or 0)
        except (TypeError, ValueError):
            total = 0.0
        # Graded map: label floor vs overall(0..5)×20, clamped 0..100.
        score = int(max(_REPUTATION_FLOOR.get(reputation, 0), min(100.0, total * 20.0)))
        behaviors = [
            str(b.get("name") or b.get("label"))
            for b in (data.get("behaviors") or [])
            if isinstance(b, dict) and (b.get("name") or b.get("label"))
        ]
        tags: list[str] = [f"reputation:{reputation}"]
        tags.extend(behaviors[:8])
        return ProviderResult(
            provider=self.name, indicator=value, indicator_kind=kind.value,
            score=score, malicious=score >= 50, confidence=0.7,
            tags=tags,
            raw={
                "seen": True,
                "reputation": reputation,
                "overall_score": total,
                "behaviors": behaviors[:15],
                "background_noise_score": data.get("background_noise_score"),
                "as_name": data.get("as_name"),
                "country": (data.get("location") or {}).get("country"),
            },
            ok=True, ts=now_utc(),
        )
