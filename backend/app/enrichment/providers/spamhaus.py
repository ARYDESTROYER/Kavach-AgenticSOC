"""Spamhaus ZEN / DBL enrichment provider (Round 11) — KEYLESS DNS, default-OFF.

Spamhaus blocklists are DNS zones: an IPv4 is checked against ZEN
(``{reversed-octets}.zen.spamhaus.org``) and a domain against DBL
(``{domain}.dbl.spamhaus.org``). The A-record answer encodes WHICH list matched:

  * ZEN 127.0.0.2-3  → SBL/CSS (spam source)            → 85, malicious
  * ZEN 127.0.0.4-7  → XBL (exploited / botnet member)  → 90, malicious
  * ZEN 127.0.0.9    → SBL DROP                         → 90, malicious
  * ZEN 127.0.0.10-11→ PBL (policy: dynamic/residential — NOT malice) → 25, context
  * DBL 127.0.1.2-6  → spam/phish/malware/botnet domain → 85, malicious
  * DBL 127.0.1.102-106 → ABUSED legitimate domain      → 40, context
  * 127.255.255.x    → ERROR codes (open-resolver refusal / over quota / blocked)
                       → NO DATA, never treated as listed
  * NXDOMAIN         → clean / unlisted

CAVEAT (why default-OFF): Spamhaus REFUSES queries relayed through large public
resolvers (Google/Cloudflare DNS) — the backend host needs its own recursive
resolver; free use is limited to low-volume, non-commercial queries. The blocking
``socket.gethostbyname`` runs in a threadpool via ``asyncio.to_thread`` (the
ProjectHoneypot pattern).
"""

from __future__ import annotations

import asyncio
import ipaddress
import socket

from ...constants import IndicatorKind
from ...models import ProviderResult
from ...utils import now_utc
from ..base import EnrichmentProvider, ProviderManifest
from ._common import rate_guard

_ZEN_ZONE = "zen.spamhaus.org"
_DBL_ZONE = "dbl.spamhaus.org"


def _query_dnsbl(name: str) -> str | None:
    """Blocking DNSBL A-record query → the raw answer (or None on NXDOMAIN = clean).
    Runs in a threadpool."""
    try:
        return socket.gethostbyname(name)
    except (socket.gaierror, OSError):
        return None  # NXDOMAIN ⇒ not listed ⇒ clean


def _classify_zen(last_two: tuple[int, int]) -> tuple[int, bool, list[str]] | None:
    """(third, fourth octet) of a ZEN 127.0.0.x answer → (score, malicious, tags)."""
    third, code = last_two
    if third != 0:
        return None
    if code in (2, 3):
        return 85, True, ["sbl", "spam_source"]
    if code in (4, 5, 6, 7):
        return 90, True, ["xbl", "exploited_or_botnet"]
    if code == 9:
        return 90, True, ["sbl_drop"]
    if code in (10, 11):
        # PBL is POLICY (dynamic/residential ranges shouldn't emit direct mail) —
        # context, not malice (#3).
        return 25, False, ["pbl_policy"]
    return None


def _classify_dbl(last_two: tuple[int, int]) -> tuple[int, bool, list[str]] | None:
    """(third, fourth octet) of a DBL 127.0.1.x answer → (score, malicious, tags)."""
    third, code = last_two
    if third != 1:
        return None
    names = {2: "spam", 4: "phishing", 5: "malware", 6: "botnet_cc"}
    if code in names:
        return 85, True, [f"dbl:{names[code]}"]
    if 102 <= code <= 106:
        # A LEGITIMATE domain currently being abused — context, not a verdict on
        # the domain itself (#3).
        return 40, False, ["dbl:abused_legit"]
    return None


class SpamhausProvider(EnrichmentProvider):
    name = "spamhaus"

    @classmethod
    def manifest(cls) -> ProviderManifest:
        return ProviderManifest(
            name=cls.name,
            display_name="Spamhaus ZEN / DBL",
            description=(
                "DNS blocklist check: ZEN (SBL/XBL/PBL) for IPs, DBL for domains. A "
                "listed IP/domain is a strong spam/botnet signal; PBL and "
                "abused-legit codes stay context-only."
            ),
            indicator_kinds=[IndicatorKind.IP, IndicatorKind.DOMAIN],
            config_key="use_spamhaus",
            secret_fields=[],
            keyless=True,
            free_tier=(
                "Keyless for low-volume non-commercial use. IMPORTANT: queries via "
                "public resolvers (Google/Cloudflare DNS) are refused — the backend "
                "host needs its own recursive resolver. 127.255.255.x answers mean "
                "'refused/over-quota' and are treated as no-data, never as listed."
            ),
            docs_url="https://www.spamhaus.org/blocklists/",
            default_enabled=False,
            setup_steps=[
                "Ensure the backend host resolves DNS through its OWN recursive "
                "resolver (not 8.8.8.8 / 1.1.1.1 — Spamhaus refuses public "
                "resolvers and answers an error code instead).",
                "No key needed for low-volume, non-commercial use; heavy or "
                "commercial use requires a Spamhaus DQS subscription (not wired "
                "here).",
                "Flip this provider's toggle ON (default OFF because of the "
                "resolver caveat).",
                "Optionally verify from the backend host: `host "
                "2.0.0.127.zen.spamhaus.org` should answer 127.0.0.x.",
            ],
            example=(
                "A sender IP on the XBL (exploited/botnet member) turns a 'strange "
                "outbound SMTP' alert into a likely compromised-host case, while a "
                "PBL-only hit merely says 'residential line' — the per-list return "
                "code keeps those apart."
            ),
        )

    async def _lookup(self, value: str, kind: IndicatorKind) -> ProviderResult:
        await rate_guard(self.name)
        zone = _DBL_ZONE
        qname: str | None = None
        if kind == IndicatorKind.IP:
            zone = _ZEN_ZONE
            try:
                addr = ipaddress.ip_address(value)
            except ValueError:
                addr = None
            if addr is None or addr.version != 4:
                # ZEN is IPv4-oriented here — neutral, not an error.
                return ProviderResult(
                    provider=self.name, indicator=value, indicator_kind=kind.value,
                    score=0, malicious=False, tags=[], raw={"listed": False, "supported": False},
                    ok=True, ts=now_utc(),
                )
            qname = f"{'.'.join(reversed(value.split('.')))}.{zone}"
        else:
            qname = f"{value.strip().strip('.').lower()}.{zone}"
        answer = await asyncio.to_thread(_query_dnsbl, qname)
        if not answer:
            return ProviderResult(
                provider=self.name, indicator=value, indicator_kind=kind.value,
                score=0, malicious=False, tags=[], raw={"listed": False},
                ok=True, ts=now_utc(),
            )
        parts = answer.split(".")
        if len(parts) != 4 or parts[0] != "127":
            return ProviderResult(
                provider=self.name, indicator=value, indicator_kind=kind.value,
                score=0, malicious=False, tags=[], raw={"listed": False, "answer": answer},
                ok=True, ts=now_utc(),
            )
        try:
            second, third, code = int(parts[1]), int(parts[2]), int(parts[3])
        except ValueError:
            second, third, code = -1, -1, -1
        if second == 255 and third == 255:
            # 127.255.255.x — refused (open resolver) / over quota / blocked. This is
            # NO DATA, never a listing (the manifest caveat).
            return ProviderResult(
                provider=self.name, indicator=value, indicator_kind=kind.value,
                score=0, malicious=False, tags=["query_refused"],
                raw={"listed": False, "refused": True, "answer": answer},
                ok=True, ts=now_utc(),
            )
        classified = (
            _classify_zen((third, code)) if kind == IndicatorKind.IP
            else _classify_dbl((third, code))
        )
        if classified is None:
            return ProviderResult(
                provider=self.name, indicator=value, indicator_kind=kind.value,
                score=0, malicious=False, tags=[], raw={"listed": False, "answer": answer},
                ok=True, ts=now_utc(),
            )
        score, malicious, tags = classified
        return ProviderResult(
            provider=self.name, indicator=value, indicator_kind=kind.value,
            score=score, malicious=malicious, confidence=0.85 if malicious else 0.5,
            tags=tags,
            raw={"listed": True, "answer": answer, "zone": zone},
            ok=True, ts=now_utc(),
        )
