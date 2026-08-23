"""abuse.ch trio enrichment providers (Round 3 Wave 2) — URLhaus / ThreatFox / MalwareBazaar.

Three providers backed by abuse.ch's free community APIs. Each is KEYLESS by default (the
``use_urlhaus`` / ``use_threatfox`` / ``use_malwarebazaar`` toggles need no key). As of
Round 3 Wave 2b, an OPTIONAL ``Secrets.abusech_auth_key`` is wired: when configured, the
providers send it as the ``Auth-Key`` header (abuse.ch now requires it on some endpoints
/ for higher rate limits); when unset, they call the public endpoints exactly as before
(the keyless path is byte-identical), failing open on the auth-required path:

  * **URLhaus** — malicious-URL / host database. Handles URL + DOMAIN. A listed
    indicator scores 90 (it is, by definition, in a malware-URL feed).
  * **ThreatFox** — IOC database (IPs, domains, URLs, hashes). Score scales with the
    abuse.ch confidence level the IOC carries.
  * **MalwareBazaar** — malware-sample database keyed by FILE_HASH. A known-bad sample
    scores 90 + carries its signature/family as UNTRUSTED tags.

Every abuse.ch field (threat name, signature, family, tag) is UNTRUSTED, source-
controlled text and is fenced before a prompt (#9).
"""

from __future__ import annotations

from typing import Any

from ...constants import IndicatorKind
from ...models import ProviderResult
from ...utils import now_utc
from ..base import EnrichmentProvider, ProviderManifest
from ._common import http_json_soft as http_json

_URLHAUS_URL = "https://urlhaus-api.abuse.ch/v1/host/"
_URLHAUS_URLINFO = "https://urlhaus-api.abuse.ch/v1/url/"
_THREATFOX_URL = "https://threatfox-api.abuse.ch/api/v1/"
_BAZAAR_URL = "https://mb-api.abuse.ch/api/v1/"


def _auth_headers(provider: EnrichmentProvider) -> dict[str, str] | None:
    """The optional abuse.ch ``Auth-Key`` header for ``provider`` when
    ``Secrets.abusech_auth_key`` is set, else ``None`` (keyless public-endpoint path,
    byte-identical to the prior behaviour). The key is SECRET-tier; only the header is
    sent — it is never returned to the UI (#10)."""
    key = provider._secret("abusech_auth_key")
    if key:
        return {"Auth-Key": str(key)}
    return None


def _confidence_to_score(level: Any) -> int:
    """abuse.ch confidence level (0..100) → our 0..100 score, with a floor of 60 for any
    listed IOC (being in ThreatFox at all is a strong signal)."""
    try:
        lvl = float(level)
    except (TypeError, ValueError):
        lvl = 75.0
    return int(max(60.0, min(100.0, lvl)))


class URLhausProvider(EnrichmentProvider):
    name = "urlhaus"

    @classmethod
    def manifest(cls) -> ProviderManifest:
        return ProviderManifest(
            name=cls.name,
            display_name="URLhaus (abuse.ch)",
            description="abuse.ch malicious-URL / host database. Keyless.",
            indicator_kinds=[IndicatorKind.URL, IndicatorKind.DOMAIN],
            config_key="use_urlhaus",
            secret_fields=[],
            keyless=True,
            free_tier="Keyless community API",
            docs_url="https://urlhaus-api.abuse.ch/",
            default_enabled=True,
            setup_steps=[
                "Nothing required — URLhaus is keyless and ships enabled.",
                "Optional: create a free abuse.ch account, generate an Auth-Key and "
                "set TLSOC_ABUSECH_AUTH_KEY in .env (compose maps it to "
                "ABUSECH_AUTH_KEY) — one key lifts the rate caps for URLhaus, "
                "ThreatFox and MalwareBazaar together.",
            ],
            example=(
                "A proxied download URL that URLhaus lists as an active Emotet "
                "payload host turns a 'user visited unusual URL' alert into a "
                "confirmed malware-delivery case on the spot."
            ),
        )

    async def _lookup(self, value: str, kind: IndicatorKind) -> ProviderResult:
        headers = _auth_headers(self)
        if kind == IndicatorKind.URL:
            data = await http_json(_URLHAUS_URLINFO, method="POST", data={"url": value},
                                   headers=headers)
        else:  # DOMAIN / host
            data = await http_json(_URLHAUS_URL, method="POST", data={"host": value},
                                   headers=headers)
        data = data if isinstance(data, dict) else {}
        status = str(data.get("query_status") or "")
        if status != "ok":
            # no_results / invalid → clean miss.
            return ProviderResult(
                provider=self.name, indicator=value, indicator_kind=kind.value,
                score=0, malicious=False, raw={"query_status": status}, ok=True, ts=now_utc(),
            )
        urls = data.get("urls") or []
        threat = data.get("threat") or (urls[0].get("threat") if urls and isinstance(urls[0], dict) else None)
        tags_raw: list[str] = []
        for u in urls if isinstance(urls, list) else []:
            if isinstance(u, dict):
                tags_raw.extend(str(t) for t in (u.get("tags") or []))
        if data.get("tags"):
            tags_raw.extend(str(t) for t in data["tags"])
        return ProviderResult(
            provider=self.name, indicator=value, indicator_kind=kind.value,
            score=90, malicious=True, confidence=0.9,
            tags=([f"threat:{threat}"] if threat else []) + tags_raw[:10],
            raw={
                "threat": threat,
                "url_count": data.get("url_count") or len(urls),
                "tags": tags_raw[:20],
            },
            ok=True, ts=now_utc(),
        )


class ThreatFoxProvider(EnrichmentProvider):
    name = "threatfox"

    @classmethod
    def manifest(cls) -> ProviderManifest:
        return ProviderManifest(
            name=cls.name,
            display_name="ThreatFox (abuse.ch)",
            description="abuse.ch IOC database (IPs, domains, URLs, hashes). Keyless.",
            indicator_kinds=[
                IndicatorKind.IP, IndicatorKind.DOMAIN, IndicatorKind.URL, IndicatorKind.FILE_HASH,
            ],
            config_key="use_threatfox",
            secret_fields=[],
            keyless=True,
            free_tier="Keyless community API",
            docs_url="https://threatfox-api.abuse.ch/",
            default_enabled=True,
            setup_steps=[
                "Nothing required — ThreatFox is keyless and ships enabled.",
                "Optional: set TLSOC_ABUSECH_AUTH_KEY in .env (shared abuse.ch "
                "Auth-Key; compose maps it to ABUSECH_AUTH_KEY) to lift the keyless "
                "rate caps.",
            ],
            example=(
                "Matches an outbound connection against known IOCs with malware "
                "attribution: '198.51.100.7 = Cobalt Strike C2, confidence 90' is "
                "the difference between a routine egress alert and an incident."
            ),
        )

    async def _lookup(self, value: str, kind: IndicatorKind) -> ProviderResult:
        body = await http_json(
            _THREATFOX_URL, method="POST",
            json_body={"query": "search_ioc", "search_term": value},
            headers=_auth_headers(self),
        )
        body = body if isinstance(body, dict) else {}
        status = str(body.get("query_status") or "")
        rows = body.get("data") or []
        if status != "ok" or not rows:
            return ProviderResult(
                provider=self.name, indicator=value, indicator_kind=kind.value,
                score=0, malicious=False, raw={"query_status": status}, ok=True, ts=now_utc(),
            )
        first = rows[0] if isinstance(rows, list) and rows and isinstance(rows[0], dict) else {}
        score = _confidence_to_score(first.get("confidence_level"))
        malware = first.get("malware_printable") or first.get("malware")
        threat_type = first.get("threat_type")
        ioc_tags = [str(t) for t in (first.get("tags") or [])]
        tags: list[str] = []
        if malware:
            tags.append(f"malware:{malware}")
        if threat_type:
            tags.append(f"type:{threat_type}")
        tags.extend(ioc_tags[:8])
        return ProviderResult(
            provider=self.name, indicator=value, indicator_kind=kind.value,
            score=score, malicious=score >= 50, confidence=0.85,
            tags=tags,
            raw={
                "malware": malware,
                "threat_type": threat_type,
                "confidence_level": first.get("confidence_level"),
                "ioc_count": len(rows) if isinstance(rows, list) else 1,
                "tags": ioc_tags[:15],
            },
            ok=True, ts=now_utc(),
        )


class MalwareBazaarProvider(EnrichmentProvider):
    name = "malwarebazaar"

    @classmethod
    def manifest(cls) -> ProviderManifest:
        return ProviderManifest(
            name=cls.name,
            display_name="MalwareBazaar (abuse.ch)",
            description="abuse.ch malware-sample database keyed by file hash. Keyless.",
            indicator_kinds=[IndicatorKind.FILE_HASH],
            config_key="use_malwarebazaar",
            secret_fields=[],
            keyless=True,
            free_tier="Keyless community API",
            docs_url="https://bazaar.abuse.ch/api/",
            default_enabled=True,
            setup_steps=[
                "Nothing required — MalwareBazaar is keyless and ships enabled.",
                "Optional: set TLSOC_ABUSECH_AUTH_KEY in .env (shared abuse.ch "
                "Auth-Key; compose maps it to ABUSECH_AUTH_KEY) to lift the keyless "
                "rate caps.",
            ],
            example=(
                "A quarantined file's hash resolving to a known AgentTesla sample "
                "(with family and file-type tags) confirms the EDR verdict and hands "
                "the analyst the malware family for the case summary."
            ),
        )

    async def _lookup(self, value: str, kind: IndicatorKind) -> ProviderResult:
        body = await http_json(
            _BAZAAR_URL, method="POST",
            data={"query": "get_info", "hash": value},
            headers=_auth_headers(self),
        )
        body = body if isinstance(body, dict) else {}
        status = str(body.get("query_status") or "")
        rows = body.get("data") or []
        if status != "ok" or not rows:
            return ProviderResult(
                provider=self.name, indicator=value, indicator_kind=kind.value,
                score=0, malicious=False, raw={"query_status": status}, ok=True, ts=now_utc(),
            )
        first = rows[0] if isinstance(rows, list) and rows and isinstance(rows[0], dict) else {}
        signature = first.get("signature")
        file_type = first.get("file_type")
        sample_tags = [str(t) for t in (first.get("tags") or [])]
        tags: list[str] = []
        if signature:
            tags.append(f"family:{signature}")
        if file_type:
            tags.append(f"type:{file_type}")
        tags.extend(sample_tags[:8])
        return ProviderResult(
            provider=self.name, indicator=value, indicator_kind=kind.value,
            score=90, malicious=True, confidence=0.9,
            tags=tags,
            raw={
                "signature": signature,
                "file_type": file_type,
                "file_name": first.get("file_name"),
                "first_seen": first.get("first_seen"),
                "tags": sample_tags[:15],
            },
            ok=True, ts=now_utc(),
        )
