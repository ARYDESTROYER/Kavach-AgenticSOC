"""Have I Been Pwned (HIBP) enrichment provider (Round 3 Wave 2) — key-gated, email.

HIBP ``/api/v3/breachedaccount/{email}`` lists the breaches an email address appears in.
This is EXPOSURE context (the account's credentials may be public), not a maliciousness
verdict about the email itself, so the score is modest: 0 when clean, 40 when breached
(so it informs a credential-stuffing / account-takeover investigation without alone
clearing the 50 malicious cut). Key-gated (``Secrets.hibp_api_key``, the ``hibp-api-key``
header). Every breach name is UNTRUSTED and fenced before a prompt (#9).
"""

from __future__ import annotations

from urllib.parse import quote

from ...constants import IndicatorKind
from ...models import ProviderResult
from ...utils import now_utc
from ..base import EnrichmentProvider, ProviderManifest, ProviderSecretField
from ._common import http_json

_URL = "https://haveibeenpwned.com/api/v3/breachedaccount/{email}"


class HIBPProvider(EnrichmentProvider):
    name = "hibp"

    @classmethod
    def manifest(cls) -> ProviderManifest:
        return ProviderManifest(
            name=cls.name,
            display_name="Have I Been Pwned",
            description=(
                "Breaches an email address appears in. Exposure context for account-"
                "takeover / credential-stuffing triage, not a verdict about the email."
            ),
            indicator_kinds=[IndicatorKind.EMAIL],
            config_key="use_hibp",
            secret_fields=[
                ProviderSecretField(
                    key="hibp_api_key",
                    label="HIBP API key",
                    required=True,
                    help="API key from haveibeenpwned.com (paid subscription).",
                    help_link="https://haveibeenpwned.com/API/Key",
                ),
            ],
            keyless=False,
            free_tier="Paid API key required",
            docs_url="https://haveibeenpwned.com/API/v3",
            default_enabled=False,
            setup_steps=[
                "Buy an API key at haveibeenpwned.com/API/Key (small monthly "
                "subscription; no free tier).",
                "Set TLSOC_HIBP_API_KEY in .env (compose maps it to HIBP_API_KEY), "
                "or paste it in this card (in-memory until restart).",
                "Flip this provider's toggle ON.",
            ],
            example=(
                "On an impossible-travel or password-spray case, knowing the target "
                "account appears in 12 public breaches makes credential reuse the "
                "leading hypothesis and prioritises a forced reset."
            ),
        )

    async def _lookup(self, value: str, kind: IndicatorKind) -> ProviderResult:
        key = self._secret("hibp_api_key")
        if not key:
            return ProviderResult(
                provider=self.name, indicator=value, indicator_kind=kind.value,
                ok=False, error="hibp: no api key",
            )
        data = await http_json(
            _URL.format(email=quote(value, safe="")),
            params={"truncateResponse": "true"},
            headers={"hibp-api-key": key, "user-agent": "tlsoc-triage", "Accept": "application/json"},
            # 404 from HIBP means "no breaches" — a CLEAN account, not an error.
            treat_404_as_empty=True,
        )
        breaches = data if isinstance(data, list) else []
        names = [str(b.get("Name")) for b in breaches if isinstance(b, dict) and b.get("Name")]
        # The truncated response may be a list of {"Name": ...} or bare strings.
        if not names and breaches:
            names = [str(b) for b in breaches if isinstance(b, str)]
        count = len(names)
        score = 40 if count else 0
        tags: list[str] = [f"breaches:{count}"]
        tags.extend(names[:8])
        return ProviderResult(
            provider=self.name, indicator=value, indicator_kind=kind.value,
            score=score, malicious=False, confidence=0.5 if count else 0.2,
            tags=tags,
            raw={"breach_count": count, "breaches": names[:25]},
            ok=True, ts=now_utc(),
        )
