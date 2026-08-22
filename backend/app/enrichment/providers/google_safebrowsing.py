"""Google Safe Browsing v4 enrichment provider (Round 11) — key-gated, URL/domain.

Safe Browsing's ``threatMatches:find`` answers whether a URL is on Google's MALWARE /
SOCIAL_ENGINEERING / UNWANTED_SOFTWARE / POTENTIALLY_HARMFUL_APPLICATION lists — the
same lists Chrome's warning page uses. A match is a true VERDICT feed → 90,
``malicious=True``, tagged with the threat type. No match (an empty response) is a
clean miss. Key-gated (``Secrets.google_safebrowsing_api_key``); the key rides as a
``?key=`` query param per Google's API convention — ``http_json`` scrubs the query
string from any HTTP error so the key can never leak (#10 / audit #5). Domains are
checked as URLs (Safe Browsing matches hosts). Threat-type strings are UNTRUSTED and
fenced before a prompt (#9).
"""

from __future__ import annotations

from ...constants import IndicatorKind
from ...models import ProviderResult
from ...utils import now_utc
from ..base import EnrichmentProvider, ProviderManifest, ProviderSecretField
from ._common import http_json, rate_guard

_URL = "https://safebrowsing.googleapis.com/v4/threatMatches:find"

_THREAT_TYPES = [
    "MALWARE",
    "SOCIAL_ENGINEERING",
    "UNWANTED_SOFTWARE",
    "POTENTIALLY_HARMFUL_APPLICATION",
]


class GoogleSafeBrowsingProvider(EnrichmentProvider):
    name = "google_safebrowsing"

    @classmethod
    def manifest(cls) -> ProviderManifest:
        return ProviderManifest(
            name=cls.name,
            display_name="Google Safe Browsing",
            description=(
                "Google's malware / phishing (social-engineering) / unwanted-"
                "software URL lists — the same verdicts Chrome warns on. A match is "
                "a strong known-bad signal."
            ),
            indicator_kinds=[IndicatorKind.URL, IndicatorKind.DOMAIN],
            config_key="use_google_safebrowsing",
            secret_fields=[
                ProviderSecretField(
                    key="google_safebrowsing_api_key",
                    label="Safe Browsing API key",
                    required=True,
                    help="Google Cloud API key with the Safe Browsing API enabled.",
                    help_link="https://developers.google.com/safe-browsing/v4/get-started",
                ),
            ],
            keyless=False,
            free_tier="Free Google Cloud API key (generous default quota)",
            docs_url="https://developers.google.com/safe-browsing/v4",
            default_enabled=False,
            setup_steps=[
                "In the Google Cloud console, create (or pick) a project and enable "
                "the 'Safe Browsing API'.",
                "Create an API key under APIs & Services → Credentials (restrict it "
                "to the Safe Browsing API).",
                "Set TLSOC_GOOGLE_SAFEBROWSING_API_KEY in .env (compose maps it to "
                "GOOGLE_SAFEBROWSING_API_KEY), or paste it in this card (in-memory "
                "until restart).",
                "Flip this provider's toggle ON.",
            ],
            example=(
                "The link a user clicked is on Google's SOCIAL_ENGINEERING list — "
                "the exact verdict Chrome's red warning page uses — turning a "
                "'suspicious email link' alert into a confirmed phishing case."
            ),
        )

    async def _lookup(self, value: str, kind: IndicatorKind) -> ProviderResult:
        key = self._secret("google_safebrowsing_api_key")
        if not key:
            return ProviderResult(
                provider=self.name, indicator=value, indicator_kind=kind.value,
                ok=False, error="google_safebrowsing: no api key",
            )
        await rate_guard(self.name)
        # A bare domain is checked as a URL — Safe Browsing matches on hosts.
        url_entry = value if "://" in value else f"http://{value}/"
        body = {
            "client": {"clientId": "tlsoc-triage", "clientVersion": "1.0"},
            "threatInfo": {
                "threatTypes": _THREAT_TYPES,
                "platformTypes": ["ANY_PLATFORM"],
                "threatEntryTypes": ["URL"],
                "threatEntries": [{"url": url_entry}],
            },
        }
        data = await http_json(
            _URL, method="POST", params={"key": key}, json_body=body,
            headers={"Content-Type": "application/json"},
        )
        matches = (data or {}).get("matches") if isinstance(data, dict) else None
        matches = matches if isinstance(matches, list) else []
        if not matches:
            # An empty body means "not on any list" — a clean miss.
            return ProviderResult(
                provider=self.name, indicator=value, indicator_kind=kind.value,
                score=0, malicious=False, tags=[], raw={"listed": False},
                ok=True, ts=now_utc(),
            )
        threat_types = sorted({
            str(m.get("threatType")) for m in matches
            if isinstance(m, dict) and m.get("threatType")
        })
        return ProviderResult(
            provider=self.name, indicator=value, indicator_kind=kind.value,
            # A Safe Browsing listing is a true verdict feed (#3 discipline: 80-90).
            score=90, malicious=True, confidence=0.95,
            tags=[f"threat:{t}" for t in threat_types[:5]],
            raw={"listed": True, "threat_types": threat_types[:10], "matches": len(matches)},
            ok=True, ts=now_utc(),
        )
