"""RDAP + DNS-over-HTTPS domain enrichment provider (Round 3 Wave 2) — KEYLESS, default-on.

Two keyless domain signals fused into one provider:

  * **RDAP** (``rdap.org/domain/{domain}``) — registration metadata. We surface the
    registrar, creation date and an AGE-based heuristic: very new domains (≤ 30 days)
    get a modest 30 score (newly-registered domains are a common phishing/C2 tell), but
    RDAP is CONTEXT, never alone a verdict, so it stays below the 50 cut.
  * **DNS-over-HTTPS** (Cloudflare ``cloudflare-dns.com/dns-query``) — current A/AAAA
    resolution, so the panel shows where a domain points without a raw resolver.

Score is the RDAP age heuristic only (DoH is pure context, score 0). Keyless, gated by
``EnrichmentConfig.use_rdap``, default-on. Every registrar / nameserver / resolved-IP
string is UNTRUSTED and fenced before a prompt (#9).
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import Any

from ...constants import IndicatorKind
from ...models import ProviderResult
from ...utils import now_utc
from ..base import EnrichmentProvider, ProviderManifest
from ._common import http_json_soft as http_json

_RDAP_URL = "https://rdap.org/domain/{domain}"
_DOH_URL = "https://cloudflare-dns.com/dns-query"
_NEW_DOMAIN_DAYS = 30


def _parse_rdap_age_days(events: list[Any]) -> int | None:
    for ev in events or []:
        if not isinstance(ev, dict):
            continue
        if str(ev.get("eventAction")) == "registration":
            raw = str(ev.get("eventDate") or "")
            try:
                # RDAP dates are ISO-8601; tolerate a trailing Z.
                dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                return max(0, (datetime.now(timezone.utc) - dt).days)
            except (ValueError, TypeError):
                return None
    return None


class RDAPProvider(EnrichmentProvider):
    name = "rdap"

    @classmethod
    def manifest(cls) -> ProviderManifest:
        return ProviderManifest(
            name=cls.name,
            display_name="RDAP + DNS-over-HTTPS",
            description=(
                "Keyless domain registration (RDAP) + current A/AAAA resolution (DoH). "
                "Flags newly-registered domains; otherwise pure context."
            ),
            indicator_kinds=[IndicatorKind.DOMAIN],
            config_key="use_rdap",
            secret_fields=[],
            keyless=True,
            free_tier="Keyless (RDAP bootstrap + Cloudflare DoH)",
            docs_url="https://about.rdap.org/",
            default_enabled=True,
            setup_steps=[
                "Nothing to set up — RDAP registry data and Cloudflare DoH are "
                "keyless; this provider ships enabled.",
                "Requires outbound HTTPS to rdap.org and cloudflare-dns.com.",
            ],
            example=(
                "Flags domains registered in the last 30 days — the classic phishing "
                "tell: a login page on a 5-day-old lookalike domain jumps out even "
                "before any feed has listed it."
            ),
        )

    async def _lookup(self, value: str, kind: IndicatorKind) -> ProviderResult:
        rdap, a_records, aaaa_records = await asyncio.gather(
            self._rdap(value),
            self._resolve(value, "A"),
            self._resolve(value, "AAAA"),
            return_exceptions=True,
        )
        rdap = rdap if isinstance(rdap, dict) else {}
        a_records = a_records if isinstance(a_records, list) else []
        aaaa_records = aaaa_records if isinstance(aaaa_records, list) else []

        age_days = rdap.get("age_days")
        score = 0
        tags: list[str] = []
        if isinstance(age_days, int):
            tags.append(f"age_days:{age_days}")
            if age_days <= _NEW_DOMAIN_DAYS:
                score = 30
                tags.append("newly_registered")
        if rdap.get("registrar"):
            tags.append(f"registrar:{rdap['registrar']}")
        for ip in (a_records + aaaa_records)[:5]:
            tags.append(f"resolves:{ip}")

        return ProviderResult(
            provider=self.name, indicator=value, indicator_kind=kind.value,
            score=score, malicious=False, confidence=0.3 if score else 0.2,
            tags=tags,
            raw={
                "registrar": rdap.get("registrar"),
                "age_days": age_days,
                "nameservers": rdap.get("nameservers"),
                "a": a_records,
                "aaaa": aaaa_records,
            },
            ok=True, ts=now_utc(),
        )

    async def _rdap(self, domain: str) -> dict[str, Any]:
        data = await http_json(_RDAP_URL.format(domain=domain))
        data = data if isinstance(data, dict) else {}
        if not data:
            return {}
        registrar = None
        for ent in data.get("entities") or []:
            if isinstance(ent, dict) and "registrar" in (ent.get("roles") or []):
                # vcardArray[1] is a list of [field, {}, type, value] arrays.
                vcard = (ent.get("vcardArray") or [None, []])[1]
                for row in vcard if isinstance(vcard, list) else []:
                    if isinstance(row, list) and len(row) >= 4 and row[0] == "fn":
                        registrar = str(row[3])
                        break
        nameservers = [
            str(ns.get("ldhName")) for ns in (data.get("nameservers") or [])
            if isinstance(ns, dict) and ns.get("ldhName")
        ]
        return {
            "registrar": registrar,
            "age_days": _parse_rdap_age_days(data.get("events") or []),
            "nameservers": nameservers[:10],
        }

    async def _resolve(self, domain: str, rtype: str) -> list[str]:
        body = await http_json(
            _DOH_URL,
            params={"name": domain, "type": rtype},
            headers={"Accept": "application/dns-json"},
        )
        body = body if isinstance(body, dict) else {}
        answers = body.get("Answer") or []
        # type 1 = A, 28 = AAAA — keep only address answers (skip CNAME chains).
        want = 1 if rtype == "A" else 28
        return [
            str(a.get("data")) for a in answers
            if isinstance(a, dict) and a.get("type") == want and a.get("data")
        ][:10]
