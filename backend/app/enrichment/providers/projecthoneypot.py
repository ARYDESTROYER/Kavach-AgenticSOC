"""Project Honeypot http:BL enrichment provider (Round 3 Wave 2) — key-gated, DNS.

Project Honeypot's http:BL is a DNS blocklist: you query
``{key}.{octets-reversed}.dnsbl.httpbl.org`` and an A-record answer of ``127.d.t.b``
encodes (days-since-last-activity, threat-score 0..255, visitor-type bitmask). We map
the http:BL threat score (0..255) onto our 0..100 scale. The query is a blocking
``socket.gethostbyname`` call, so it runs in a threadpool via ``asyncio.to_thread`` to
stay async-safe. Key-gated (``Secrets.honeypot_access_key`` → ``honeypot`` toggle);
IP only. The returned PTR/visitor-type labels are UNTRUSTED tags, fenced before a
prompt (#9).
"""

from __future__ import annotations

import asyncio
import ipaddress
import socket

from ...constants import IndicatorKind
from ...models import ProviderResult
from ...utils import now_utc
from ..base import EnrichmentProvider, ProviderManifest, ProviderSecretField
from ._common import rate_guard

_ZONE = "dnsbl.httpbl.org"
# http:BL visitor-type bitmask (byte 3): 0=search engine, 1=suspicious, 2=harvester,
# 4=comment spammer (combinable).
_TYPE_BITS = {1: "suspicious", 2: "harvester", 4: "comment_spammer"}


def _query_httpbl(key: str, ip: str) -> str | None:
    """Blocking http:BL DNS query → the raw ``127.d.t.b`` answer (or None). Runs in a
    threadpool. Returns None on NXDOMAIN (a clean / unlisted IP)."""
    try:
        ipaddress.ip_address(ip)  # validate; http:BL is IPv4-only
    except ValueError:
        return None
    octets = ip.split(".")
    if len(octets) != 4:
        return None
    name = f"{key}.{'.'.join(reversed(octets))}.{_ZONE}"
    try:
        return socket.gethostbyname(name)
    except (socket.gaierror, OSError):
        return None  # NXDOMAIN ⇒ not listed ⇒ clean


class ProjectHoneypotProvider(EnrichmentProvider):
    name = "projecthoneypot"

    # Registered in BUILTIN_PROVIDERS as of Round 3 Wave 2b, now that its config gaps are
    # filled: the ``EnrichmentConfig.use_honeypot`` toggle + the
    # ``Secrets.honeypot_access_key`` field. It stays key-gated + default-OFF — it only
    # fires when both the toggle is on AND the access key is configured.
    @classmethod
    def manifest(cls) -> ProviderManifest:
        return ProviderManifest(
            name=cls.name,
            display_name="Project Honeypot (http:BL)",
            description=(
                "DNS blocklist of harvesters / comment spammers / suspicious IPs. "
                "Returns a 0..255 threat score mapped onto 0..100."
            ),
            indicator_kinds=[IndicatorKind.IP],
            config_key="use_honeypot",          # pending Wave-0 config field
            secret_fields=[
                ProviderSecretField(
                    key="honeypot_access_key",  # pending Secrets field
                    label="Project Honeypot access key",
                    required=True,
                    help="12-char http:BL access key from your Project Honeypot account.",
                    help_link="https://www.projecthoneypot.org/httpbl_configure.php",
                ),
            ],
            keyless=False,
            free_tier="Free http:BL key (DNS-based; per-key daily quota)",
            docs_url="https://www.projecthoneypot.org/httpbl_api.php",
            default_enabled=False,
            setup_steps=[
                "Create a free account at projecthoneypot.org and request an http:BL "
                "access key (12 lowercase letters).",
                "Set TLSOC_HONEYPOT_ACCESS_KEY in .env (compose maps it to "
                "HONEYPOT_ACCESS_KEY), or paste it in this card (in-memory until "
                "restart).",
                "Flip this provider's toggle ON. Lookups are DNS queries — the "
                "backend host needs outbound DNS resolution.",
            ],
            example=(
                "Classifies a web-facing source IP as a known comment spammer or "
                "email harvester with a 0..255 threat score — ideal for cutting "
                "through noisy WAF and form-abuse alerts."
            ),
        )

    async def _lookup(self, value: str, kind: IndicatorKind) -> ProviderResult:
        key = self._secret("honeypot_access_key")
        if not key:
            return ProviderResult(
                provider=self.name, indicator=value, indicator_kind=kind.value,
                ok=False, error="projecthoneypot: no access key",
            )
        await rate_guard(self.name)
        answer = await asyncio.to_thread(_query_httpbl, key, value)
        if not answer:
            return ProviderResult(
                provider=self.name, indicator=value, indicator_kind=kind.value,
                score=0, malicious=False, tags=[], raw={"listed": False},
                ok=True, ts=now_utc(),
            )
        parts = answer.split(".")
        # Valid http:BL answers always start 127.x.x.x.
        if len(parts) != 4 or parts[0] != "127":
            return ProviderResult(
                provider=self.name, indicator=value, indicator_kind=kind.value,
                score=0, malicious=False, raw={"listed": False, "answer": answer},
                ok=True, ts=now_utc(),
            )
        days = int(parts[1])
        threat = int(parts[2])         # 0..255 http:BL threat score
        type_mask = int(parts[3])
        score = int(max(0, min(100, round(threat / 255.0 * 100))))
        tags: list[str] = [f"threat:{threat}", f"last_activity_days:{days}"]
        for bit, label in _TYPE_BITS.items():
            if type_mask & bit:
                tags.append(label)
        if type_mask == 0:
            tags.append("search_engine")
        return ProviderResult(
            provider=self.name, indicator=value, indicator_kind=kind.value,
            score=score, malicious=score >= 50, confidence=0.6,
            tags=tags,
            raw={
                "listed": True,
                "threat_score": threat,
                "days_since_last_activity": days,
                "visitor_type_mask": type_mask,
            },
            ok=True, ts=now_utc(),
        )
