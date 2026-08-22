"""SANS ISC DShield enrichment provider (Round 11) — KEYLESS, default-on.

DShield aggregates firewall logs from thousands of volunteer sensors. Its
``/api/ip/{ip}?json`` endpoint reports how often an IP has been SEEN attacking the
sensor network (``count`` = log lines, ``attacks`` = distinct targets) plus any
threat-feed memberships. Sensor sightings are strong "this IP scans the internet"
context but NOT a malice verdict, so the score is scaled and CAPPED at 40 with
``malicious=False`` in every branch — it can never alone cross the legacy ``max()``
>= 50 cut (#3). Keyless ⇒ ``http_json_soft`` (advisory; unreachable degrades to
no-data). Every feed name is UNTRUSTED and fenced before a prompt (#9).
"""

from __future__ import annotations

from ...constants import IndicatorKind
from ...models import ProviderResult
from ...utils import now_utc
from ..base import EnrichmentProvider, ProviderManifest
from ._common import http_json_soft, rate_guard

_URL = "https://isc.sans.edu/api/ip/{ip}?json"


def _to_int(v: object) -> int:
    try:
        return int(v)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return 0


class DShieldProvider(EnrichmentProvider):
    name = "dshield"

    @classmethod
    def manifest(cls) -> ProviderManifest:
        return ProviderManifest(
            name=cls.name,
            display_name="SANS ISC DShield",
            description=(
                "Sensor-network sightings for an IP (how many volunteer firewalls "
                "have logged it attacking, over how many targets). Scanning context, "
                "capped below a malice verdict."
            ),
            indicator_kinds=[IndicatorKind.IP],
            config_key="use_dshield",
            secret_fields=[],
            keyless=True,
            free_tier="Keyless, no signup (free SANS ISC API; be gentle)",
            docs_url="https://isc.sans.edu/api/",
            default_enabled=True,
            setup_steps=[
                "Nothing to set up — the SANS ISC API is keyless and this provider "
                "ships enabled.",
                "Requires outbound HTTPS to isc.sans.edu.",
            ],
            example=(
                "An IP probing your VPN that DShield has seen hitting 9,000 other "
                "sensors this week is internet-wide scan noise; the same probe from "
                "an IP DShield has never logged deserves a closer look as possibly "
                "targeted."
            ),
        )

    async def _lookup(self, value: str, kind: IndicatorKind) -> ProviderResult:
        await rate_guard(self.name)
        data = await http_json_soft(_URL.format(ip=value), timeout=4.0)
        ip_obj = data.get("ip") if isinstance(data, dict) else None
        if not isinstance(ip_obj, dict):
            return ProviderResult(
                provider=self.name, indicator=value, indicator_kind=kind.value,
                score=0, malicious=False, tags=[], raw={"seen": False},
                ok=True, ts=now_utc(),
            )
        count = _to_int(ip_obj.get("count"))
        attacks = _to_int(ip_obj.get("attacks"))
        threatfeeds = ip_obj.get("threatfeeds") or {}
        feed_names = sorted(str(k) for k in threatfeeds)[:10] if isinstance(threatfeeds, dict) else []
        # Sightings context, CAPPED at 40 (#3): scale with distinct attacked targets;
        # feed membership bumps within the cap, never past it.
        score = 0
        if attacks >= 100 or count >= 1000:
            score = 40
        elif attacks >= 10 or count >= 100:
            score = 30
        elif attacks > 0 or count > 0:
            score = 15
        if feed_names:
            score = min(40, max(score, 25))
        tags: list[str] = []
        if count:
            tags.append(f"reports:{count}")
        if attacks:
            tags.append(f"targets:{attacks}")
        tags.extend(f"feed:{f}" for f in feed_names[:5])
        return ProviderResult(
            provider=self.name, indicator=value, indicator_kind=kind.value,
            score=score, malicious=False, confidence=0.4 if score else 0.2,
            tags=tags,
            raw={
                "seen": bool(count or attacks or feed_names),
                "count": count,
                "attacks": attacks,
                "threatfeeds": feed_names,
                "as_name": ip_obj.get("asname"),
                "country": ip_obj.get("ascountry"),
            },
            ok=True, ts=now_utc(),
        )
