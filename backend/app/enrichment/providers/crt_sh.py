"""crt.sh certificate-transparency enrichment provider (Round 11) — KEYLESS,
default-OFF.

crt.sh (``https://crt.sh/?q={domain}&output=json``) lists every CT-logged
certificate for a domain. Context only: certificate count and the first-logged
date corroborate (or contradict) RDAP's newly-registered signal — a domain whose
FIRST cert appeared days ago supports the "fresh phishing infra" hypothesis; years
of certificate history cuts against it. Score is CAPPED at 20 (recent first cert)
and ``malicious`` is always False (#3). crt.sh is a free community service and
often SLOW — hence ``http_json_soft`` with a tight 4s timeout, and default-OFF.
Every certificate name is UNTRUSTED and fenced before a prompt (#9).
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from ...constants import IndicatorKind
from ...models import ProviderResult
from ...utils import now_utc
from ..base import EnrichmentProvider, ProviderManifest
from ._common import http_json_soft, rate_guard

_URL = "https://crt.sh/"


def _parse_ts(raw: object) -> datetime | None:
    if not raw:
        return None
    try:
        dt = datetime.fromisoformat(str(raw))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


class CrtShProvider(EnrichmentProvider):
    name = "crt_sh"

    @classmethod
    def manifest(cls) -> ProviderManifest:
        return ProviderManifest(
            name=cls.name,
            display_name="crt.sh (Certificate Transparency)",
            description=(
                "CT-logged certificate history for a domain: how many certs, and "
                "when the first one appeared. Corroborates the newly-registered-"
                "domain signal; pure context."
            ),
            indicator_kinds=[IndicatorKind.DOMAIN],
            config_key="use_crt_sh",
            secret_fields=[],
            keyless=True,
            free_tier="Keyless community service (often slow — tight 4s timeout)",
            docs_url="https://crt.sh/",
            default_enabled=False,
            setup_steps=[
                "Nothing to sign up for — crt.sh is keyless.",
                "Flip this provider's toggle ON (default OFF because crt.sh is "
                "frequently slow; a timed-out lookup degrades to no-data).",
                "Requires outbound HTTPS to crt.sh.",
            ],
            example=(
                "The lookalike domain in a phishing case got its FIRST TLS "
                "certificate 3 days ago — CT history corroborates RDAP's "
                "newly-registered flag, while a bank's real domain shows years of "
                "certificates."
            ),
        )

    async def _lookup(self, value: str, kind: IndicatorKind) -> ProviderResult:
        await rate_guard(self.name)
        data = await http_json_soft(
            _URL, params={"q": value.strip().strip(".").lower(), "output": "json"},
            timeout=4.0,
        )
        rows = data if isinstance(data, list) else []
        entries = [r for r in rows if isinstance(r, dict)]
        if not entries:
            return ProviderResult(
                provider=self.name, indicator=value, indicator_kind=kind.value,
                score=0, malicious=False, tags=[], raw={"certificates": 0},
                ok=True, ts=now_utc(),
            )
        first_seen: datetime | None = None
        for e in entries:
            ts = _parse_ts(e.get("entry_timestamp") or e.get("not_before"))
            if ts and (first_seen is None or ts < first_seen):
                first_seen = ts
        recent_first_cert = bool(
            first_seen and (datetime.now(timezone.utc) - first_seen) <= timedelta(days=30)
        )
        issuers = sorted({str(e.get("issuer_name"))[:80] for e in entries if e.get("issuer_name")})
        # Context only (#3): a small bump when the domain's ENTIRE cert history is
        # brand new; never anywhere near the 50 cut.
        score = 20 if recent_first_cert else 0
        tags: list[str] = [f"certs:{len(entries)}"]
        if recent_first_cert:
            tags.append("first_cert_recent")
        return ProviderResult(
            provider=self.name, indicator=value, indicator_kind=kind.value,
            score=score, malicious=False, confidence=0.3,
            tags=tags,
            raw={
                "certificates": len(entries),
                "first_seen": first_seen.isoformat() if first_seen else None,
                "issuers": issuers[:10],
            },
            ok=True, ts=now_utc(),
        )
