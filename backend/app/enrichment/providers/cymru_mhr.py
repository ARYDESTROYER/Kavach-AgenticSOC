"""Team Cymru Malware Hash Registry enrichment provider (Round 11) — KEYLESS DNS.

The MHR is a DNS zone: an A-record query of ``{md5|sha1}.malware.hash.cymru.com``
answers ``127.0.0.2`` when the hash is a KNOWN MALWARE sample (seen by Team Cymru's
AV aggregation), NXDOMAIN when unknown. A listing is a true VERDICT feed → 90,
``malicious=True``. MD5/SHA-1 only (the zone does not carry SHA-256) — other hash
lengths return a neutral "unsupported" result. The blocking ``socket.gethostbyname``
runs in a threadpool via ``asyncio.to_thread`` (the ProjectHoneypot pattern);
NXDOMAIN = clean. Default-OFF: like every DNSBL it behaves best on a host with its
own recursive resolver, and unknown-vs-clean needs the operator to understand the
MD5/SHA-1 limitation.
"""

from __future__ import annotations

import asyncio
import socket

from ...constants import IndicatorKind
from ...models import ProviderResult
from ...utils import now_utc
from ..base import EnrichmentProvider, ProviderManifest
from ._common import rate_guard

_ZONE = "malware.hash.cymru.com"
_HEX = set("0123456789abcdef")


def _query_mhr(hash_lower: str) -> str | None:
    """Blocking MHR DNS query → the raw A answer (or None on NXDOMAIN = unknown).
    Runs in a threadpool."""
    try:
        return socket.gethostbyname(f"{hash_lower}.{_ZONE}")
    except (socket.gaierror, OSError):
        return None  # NXDOMAIN ⇒ not a known malware hash


class CymruMHRProvider(EnrichmentProvider):
    name = "cymru_mhr"

    @classmethod
    def manifest(cls) -> ProviderManifest:
        return ProviderManifest(
            name=cls.name,
            display_name="Team Cymru MHR",
            description=(
                "Malware Hash Registry: a DNS lookup that answers whether an MD5/"
                "SHA-1 is a known malware sample. A hit is a true known-bad verdict."
            ),
            indicator_kinds=[IndicatorKind.FILE_HASH],
            config_key="use_cymru_mhr",
            secret_fields=[],
            keyless=True,
            free_tier=(
                "Keyless DNS zone, free for non-commercial use. MD5/SHA-1 only — "
                "SHA-256 is not in the zone. Works best with the host's own "
                "recursive resolver."
            ),
            docs_url="https://www.team-cymru.com/mhr",
            default_enabled=False,
            setup_steps=[
                "Ensure the backend host can resolve DNS (ideally through its own "
                "recursive resolver rather than a heavily shared public one).",
                "No key or signup needed for reasonable non-commercial volume.",
                "Flip this provider's toggle ON.",
                "Note: only MD5 and SHA-1 hashes can be answered — SHA-256 "
                "indicators return a neutral 'unsupported' result.",
            ],
            example=(
                "A single DNS query confirms an emailed attachment's MD5 as known "
                "malware even when the sandbox queue is backed up — a hit means "
                "Team Cymru's AV aggregation has already convicted the file."
            ),
        )

    async def _lookup(self, value: str, kind: IndicatorKind) -> ProviderResult:
        h = value.strip().lower()
        if len(h) not in (32, 40) or any(c not in _HEX for c in h):
            # SHA-256 / non-hex — the zone can't answer; neutral, not an error.
            return ProviderResult(
                provider=self.name, indicator=value, indicator_kind=kind.value,
                score=0, malicious=False, tags=[], raw={"supported": False},
                ok=True, ts=now_utc(),
            )
        await rate_guard(self.name)
        answer = await asyncio.to_thread(_query_mhr, h)
        if not answer:
            return ProviderResult(
                provider=self.name, indicator=value, indicator_kind=kind.value,
                score=0, malicious=False, tags=[], raw={"listed": False},
                ok=True, ts=now_utc(),
            )
        if not answer.startswith("127.0.0."):
            # Anything but the documented 127.0.0.x answer is no-data, not a listing.
            return ProviderResult(
                provider=self.name, indicator=value, indicator_kind=kind.value,
                score=0, malicious=False, tags=[], raw={"listed": False, "answer": answer},
                ok=True, ts=now_utc(),
            )
        # Listed → a true known-malware verdict (90, like the malware-feed providers).
        return ProviderResult(
            provider=self.name, indicator=value, indicator_kind=kind.value,
            score=90, malicious=True, confidence=0.9,
            tags=["known_malware"],
            raw={"listed": True, "answer": answer},
            ok=True, ts=now_utc(),
        )
