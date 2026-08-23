"""Shodan InternetDB enrichment provider (Round 3 Wave 2) — KEYLESS, default-on.

Shodan's free, no-auth ``internetdb.shodan.io`` endpoint returns the open ports, CPEs,
hostnames, tags and vulnerabilities Shodan last observed on an IP. It is exposure
context, NOT a reputation verdict — so the score stays CONSERVATIVE: 0 by default, a
small bump (20) only when Shodan tags the host or lists known CVEs, so it never on its
own drives the legacy ``max()`` reputation above the 50 malicious cut. Every port /
CPE / hostname / tag / CVE is UNTRUSTED, source-controlled text and is fenced before a
prompt (#9). Keyless ⇒ no secret, default-on.
"""

from __future__ import annotations

from ...constants import IndicatorKind
from ...models import ProviderResult
from ...utils import now_utc
from ..base import EnrichmentProvider, ProviderManifest
from ._common import http_json_soft, rate_guard

_URL = "https://internetdb.shodan.io/{ip}"


class ShodanInternetDBProvider(EnrichmentProvider):
    name = "shodan_internetdb"

    @classmethod
    def manifest(cls) -> ProviderManifest:
        return ProviderManifest(
            name=cls.name,
            display_name="Shodan InternetDB",
            description=(
                "Keyless host-exposure context (open ports, CPEs, hostnames, tags, "
                "CVEs) from Shodan's free InternetDB. Exposure context, not a verdict."
            ),
            indicator_kinds=[IndicatorKind.IP],
            config_key="use_shodan_internetdb",
            secret_fields=[],
            keyless=True,
            free_tier="Keyless, no signup (rate-limited; be polite)",
            docs_url="https://internetdb.shodan.io/",
            default_enabled=True,
            setup_steps=[
                "Nothing to set up — InternetDB is keyless and this provider ships "
                "enabled.",
                "Optionally disable it here if your environment blocks outbound "
                "HTTPS to internetdb.shodan.io.",
            ],
            example=(
                "Shows what the internet sees on the IP in a case — an 'RDP "
                "brute-force' alert against a host InternetDB says exposes port 3389 "
                "plus known CVEs is materially more urgent than one against a host "
                "with nothing exposed."
            ),
        )

    async def _lookup(self, value: str, kind: IndicatorKind) -> ProviderResult:
        await rate_guard(self.name)
        # Advisory context — a tight timeout so a slow/unreachable host degrades fast.
        data = await http_json_soft(_URL.format(ip=value), timeout=4.0)
        if not isinstance(data, dict):
            # 404 / no record — a clean miss (Shodan has never seen this host).
            return ProviderResult(
                provider=self.name, indicator=value, indicator_kind=kind.value,
                score=0, malicious=False, tags=[], raw={"seen": False},
                ok=True, ts=now_utc(),
            )
        ports = [str(p) for p in (data.get("ports") or [])]
        cpes = [str(c) for c in (data.get("cpes") or [])]
        hostnames = [str(h) for h in (data.get("hostnames") or [])]
        sh_tags = [str(t) for t in (data.get("tags") or [])]
        vulns = [str(v) for v in (data.get("vulns") or [])]
        # CONSERVATIVE: exposure is not malice. Bump only on explicit tags/CVEs, and
        # never high enough to alone drive the legacy max() over the 50 cut.
        score = 0
        if sh_tags or vulns:
            score = 20
        tags: list[str] = []
        if ports:
            tags.append(f"open_ports:{len(ports)}")
        if vulns:
            tags.append(f"cves:{len(vulns)}")
        tags.extend(sh_tags[:10])
        return ProviderResult(
            provider=self.name, indicator=value, indicator_kind=kind.value,
            score=score, malicious=False, confidence=0.3,
            tags=tags,
            raw={
                "seen": True,
                "ports": ports,
                "cpes": cpes[:25],
                "hostnames": hostnames[:25],
                "tags": sh_tags,
                "vulns": vulns[:50],
            },
            ok=True, ts=now_utc(),
        )
