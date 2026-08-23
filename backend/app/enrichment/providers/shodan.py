"""Shodan host enrichment provider (Round 3 Wave 2) — key-gated.

The authenticated Shodan ``/shodan/host/{ip}`` endpoint returns richer host detail than
InternetDB (org/ISP, OS, ports, hostnames, tags, CVEs, country). Like InternetDB this
is EXPOSURE context, not a reputation verdict, so the score stays conservative (0, a
small 20 bump only on explicit malware/CVE tags). Key-gated
(``Secrets.shodan_api_key``); IP only; throttled to ~1 req/s. Every host string is
UNTRUSTED, source-controlled text and is fenced before a prompt (#9).
"""

from __future__ import annotations

from ...constants import IndicatorKind
from ...models import ProviderResult
from ...utils import now_utc
from ..base import EnrichmentProvider, ProviderManifest, ProviderSecretField
from ._common import http_json, rate_guard

_URL = "https://api.shodan.io/shodan/host/{ip}"
# Tags Shodan attaches that DO indicate badness (vs. plain exposure).
_BAD_TAGS = {"malware", "compromised", "honeypot", "c2", "botnet", "phishing"}


class ShodanProvider(EnrichmentProvider):
    name = "shodan"

    @classmethod
    def manifest(cls) -> ProviderManifest:
        return ProviderManifest(
            name=cls.name,
            display_name="Shodan (host)",
            description=(
                "Authenticated Shodan host detail (org/ISP, OS, ports, CVEs, tags). "
                "Richer than InternetDB; exposure context, not a verdict."
            ),
            indicator_kinds=[IndicatorKind.IP],
            config_key="use_shodan",
            secret_fields=[
                ProviderSecretField(
                    key="shodan_api_key",
                    label="Shodan API key",
                    required=True,
                    help="API key from your Shodan account (Account → API key).",
                    help_link="https://account.shodan.io/",
                ),
            ],
            keyless=False,
            free_tier="Membership / pay-as-you-go; ~1 req/s",
            docs_url="https://developer.shodan.io/api",
            default_enabled=False,
            setup_steps=[
                "Log in at account.shodan.io (a one-time Membership unlocks API "
                "credits) and copy your API key.",
                "Set TLSOC_SHODAN_API_KEY in .env (compose maps it to "
                "SHODAN_API_KEY), or paste it in this card (in-memory until restart).",
                "Flip this provider's toggle ON. The keyless InternetDB provider "
                "already covers basic exposure — enable this one for org/ISP, OS and "
                "richer banner detail.",
            ],
            example=(
                "Adds the who-and-what behind an IP: the same alert reads differently "
                "when Shodan shows the source is a hosting-provider VPS tagged "
                "'malware' versus a university mail server."
            ),
        )

    async def _lookup(self, value: str, kind: IndicatorKind) -> ProviderResult:
        key = self._secret("shodan_api_key")
        if not key:
            return ProviderResult(
                provider=self.name, indicator=value, indicator_kind=kind.value,
                ok=False, error="shodan: no api key",
            )
        await rate_guard(self.name)
        data = await http_json(_URL.format(ip=value), params={"key": key})
        if not isinstance(data, dict):
            return ProviderResult(
                provider=self.name, indicator=value, indicator_kind=kind.value,
                score=0, malicious=False, raw={"seen": False}, ok=True, ts=now_utc(),
            )
        ports = [str(p) for p in (data.get("ports") or [])]
        sh_tags = [str(t) for t in (data.get("tags") or [])]
        vulns_raw = data.get("vulns") or []
        vulns = [str(v) for v in (list(vulns_raw.keys()) if isinstance(vulns_raw, dict) else vulns_raw)]
        country = data.get("country_code") or data.get("country_name") or None
        bad = bool({t.lower() for t in sh_tags} & _BAD_TAGS)
        score = 60 if bad else (20 if (sh_tags or vulns) else 0)
        tags: list[str] = list(sh_tags[:10])
        if ports:
            tags.append(f"open_ports:{len(ports)}")
        if vulns:
            tags.append(f"cves:{len(vulns)}")
        return ProviderResult(
            provider=self.name, indicator=value, indicator_kind=kind.value,
            score=score, malicious=score >= 50, confidence=0.5 if bad else 0.3,
            tags=tags,
            raw={
                "seen": True,
                "org": data.get("org"),
                "isp": data.get("isp"),
                "os": data.get("os"),
                "country": country,
                "ports": ports,
                "tags": sh_tags,
                "vulns": vulns[:50],
                "hostnames": [str(h) for h in (data.get("hostnames") or [])][:25],
            },
            ok=True, ts=now_utc(),
        )
