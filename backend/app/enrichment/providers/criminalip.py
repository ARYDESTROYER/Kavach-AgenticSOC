"""Criminal IP enrichment provider (Round 11) — key-gated, IP asset report.

Criminal IP's ``/v1/asset/ip/report`` grades an IP's INBOUND (as a client/attacker)
and OUTBOUND (as a server) risk on a 5-level ladder (Safe/Low/Moderate/Dangerous/
Critical — some deployments return the numeric 1..5). GRADED map from the worse of
the two directions: Safe→0, Low→20, Moderate→40, Dangerous→80, Critical→100 — only
Dangerous/Critical (>= 50) carry ``malicious=True``, so a mid-ladder 'Moderate'
stays below the legacy ``max()`` fusion cut (#3). Key-gated
(``Secrets.criminalip_api_key``, the ``x-api-key`` header). Issue labels are
UNTRUSTED and fenced before a prompt (#9).
"""

from __future__ import annotations

from typing import Any

from ...constants import IndicatorKind
from ...models import ProviderResult
from ...utils import now_utc
from ..base import EnrichmentProvider, ProviderManifest, ProviderSecretField
from ._common import http_json, rate_guard

_URL = "https://api.criminalip.io/v1/asset/ip/report"

_LEVELS = {"safe": 1, "low": 2, "moderate": 3, "dangerous": 4, "critical": 5}


def _level(value: Any) -> int:
    """A Criminal IP score value (string level or numeric 1..5) → 0..5."""
    if isinstance(value, str):
        return _LEVELS.get(value.strip().lower(), 0)
    try:
        return max(0, min(5, int(value)))
    except (TypeError, ValueError):
        return 0


class CriminalIPProvider(EnrichmentProvider):
    name = "criminalip"

    @classmethod
    def manifest(cls) -> ProviderManifest:
        return ProviderManifest(
            name=cls.name,
            display_name="Criminal IP",
            description=(
                "Graded inbound/outbound risk for an IP (Safe → Critical) from "
                "Criminal IP's asset scanning, with open-port and issue context."
            ),
            indicator_kinds=[IndicatorKind.IP],
            config_key="use_criminalip",
            secret_fields=[
                ProviderSecretField(
                    key="criminalip_api_key",
                    label="Criminal IP API key",
                    required=True,
                    help="API key from your criminalip.io account (free monthly credits).",
                    help_link="https://www.criminalip.io/mypage/information",
                ),
            ],
            keyless=False,
            free_tier="Free account with monthly credits",
            docs_url="https://www.criminalip.io/developer/api/get-asset-ip-report",
            default_enabled=False,
            setup_steps=[
                "Create an account at criminalip.io (free plans include monthly API "
                "credits) and copy the API key from My Page → API.",
                "Set TLSOC_CRIMINALIP_API_KEY in .env (compose maps it to "
                "CRIMINALIP_API_KEY), or paste it in this card (in-memory until "
                "restart).",
                "Flip this provider's toggle ON.",
            ],
            example=(
                "An IP graded 'Critical' inbound with scanner/VPN issues flagged "
                "gives the router an immediate risk anchor, while 'Safe/Safe' "
                "supports closing a low-signal alert."
            ),
        )

    async def _lookup(self, value: str, kind: IndicatorKind) -> ProviderResult:
        key = self._secret("criminalip_api_key")
        if not key:
            return ProviderResult(
                provider=self.name, indicator=value, indicator_kind=kind.value,
                ok=False, error="criminalip: no api key",
            )
        await rate_guard(self.name)
        data = await http_json(
            _URL, params={"ip": value},
            headers={"x-api-key": key, "Accept": "application/json"},
        )
        data = data if isinstance(data, dict) else {}
        score_obj = data.get("score") or {}
        inbound = _level(score_obj.get("inbound"))
        outbound = _level(score_obj.get("outbound"))
        worst = max(inbound, outbound)
        if worst == 0:
            return ProviderResult(
                provider=self.name, indicator=value, indicator_kind=kind.value,
                score=0, malicious=False, tags=[], raw={"seen": False},
                ok=True, ts=now_utc(),
            )
        # Graded 1..5 ladder → 0..100 (Safe 0 / Low 20 / Moderate 40 / Dangerous 80
        # / Critical 100): only Dangerous/Critical cross the 50 malicious cut (#3).
        score = {1: 0, 2: 20, 3: 40, 4: 80, 5: 100}.get(worst, 0)
        issues = data.get("issues") or {}
        issue_tags = [str(k) for k, v in issues.items() if v is True] if isinstance(issues, dict) else []
        tags = [f"inbound:{inbound}", f"outbound:{outbound}"] + issue_tags[:6]
        return ProviderResult(
            provider=self.name, indicator=value, indicator_kind=kind.value,
            score=score, malicious=score >= 50, confidence=0.6,
            tags=tags,
            raw={
                "seen": True,
                "inbound_level": inbound,
                "outbound_level": outbound,
                "issues": issue_tags[:12],
            },
            ok=True, ts=now_utc(),
        )
