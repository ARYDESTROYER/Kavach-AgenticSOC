"""EmailRep (Sublime Security) enrichment provider (Round 11) — key-gated, email.

EmailRep's ``/{email}`` scores an email address' reputation from breach data,
social profiles and observed malicious activity: a high/medium/low/none
``reputation``, a ``suspicious`` flag and ``details`` such as
``malicious_activity``, ``credentials_leaked`` and ``days_since_domain_creation``.
Sender-trust context for phishing/BEC triage, not a hard verdict: observed
malicious activity → 60, suspicious-only → 40, else 0. Complements HIBP (breach
exposure) as the second EMAIL-kind provider. Key-gated
(``Secrets.emailrep_api_key``, the ``Key`` header; EmailRep also expects a real
``User-Agent``). Profile names are UNTRUSTED and fenced before a prompt (#9).
"""

from __future__ import annotations

from urllib.parse import quote

from ...constants import IndicatorKind
from ...models import ProviderResult
from ...utils import now_utc
from ..base import EnrichmentProvider, ProviderManifest, ProviderSecretField
from ._common import http_json, rate_guard

_URL = "https://emailrep.io/{email}"


class EmailRepProvider(EnrichmentProvider):
    name = "emailrep"

    @classmethod
    def manifest(cls) -> ProviderManifest:
        return ProviderManifest(
            name=cls.name,
            display_name="EmailRep",
            description=(
                "Email-address reputation from Sublime Security: suspicious flag, "
                "observed malicious activity (phishing/spam), credential leaks and "
                "social-profile footprint."
            ),
            indicator_kinds=[IndicatorKind.EMAIL],
            config_key="use_emailrep",
            secret_fields=[
                ProviderSecretField(
                    key="emailrep_api_key",
                    label="EmailRep API key",
                    required=True,
                    help="Free key issued on request by Sublime Security (emailrep.io).",
                    help_link="https://emailrep.io/key",
                ),
            ],
            keyless=False,
            free_tier="Free key on request (tight daily quota)",
            docs_url="https://docs.sublimesecurity.com/reference/get_email",
            default_enabled=False,
            setup_steps=[
                "Request a free API key at emailrep.io/key (issued by Sublime "
                "Security; expect a short wait).",
                "Set TLSOC_EMAILREP_API_KEY in .env (compose maps it to "
                "EMAILREP_API_KEY), or paste it in this card (in-memory until "
                "restart).",
                "Flip this provider's toggle ON — together with HIBP it covers the "
                "email indicator kind.",
            ],
            example=(
                "The 'CEO' address behind a wire-transfer request has zero social "
                "footprint, a days-old domain and prior malicious activity on "
                "record — EmailRep separates a spoofed BEC sender from the real "
                "executive's account in one lookup."
            ),
        )

    async def _lookup(self, value: str, kind: IndicatorKind) -> ProviderResult:
        key = self._secret("emailrep_api_key")
        if not key:
            return ProviderResult(
                provider=self.name, indicator=value, indicator_kind=kind.value,
                ok=False, error="emailrep: no api key",
            )
        await rate_guard(self.name)
        data = await http_json(
            _URL.format(email=quote(value.strip(), safe="")),
            headers={"Key": key, "User-Agent": "tlsoc-triage", "Accept": "application/json"},
        )
        data = data if isinstance(data, dict) else {}
        if not data or data.get("status") == "fail":
            return ProviderResult(
                provider=self.name, indicator=value, indicator_kind=kind.value,
                score=0, malicious=False, tags=[], raw={"seen": False},
                ok=True, ts=now_utc(),
            )
        details = data.get("details") or {}
        reputation = str(data.get("reputation") or "none")
        suspicious = bool(data.get("suspicious"))
        malicious_activity = bool(details.get("malicious_activity"))
        credentials_leaked = bool(details.get("credentials_leaked"))
        # Sender-trust context: observed malicious activity 60, suspicious 40 — it
        # informs but a single email-reputation signal should not alone convict.
        if malicious_activity:
            score = 60
        elif suspicious:
            score = 40
        else:
            score = 0
        tags: list[str] = [f"reputation:{reputation}"]
        if suspicious:
            tags.append("suspicious")
        if malicious_activity:
            tags.append("malicious_activity")
        if credentials_leaked:
            tags.append("credentials_leaked")
        if details.get("days_since_domain_creation") is not None:
            tags.append(f"domain_age_days:{details.get('days_since_domain_creation')}")
        return ProviderResult(
            provider=self.name, indicator=value, indicator_kind=kind.value,
            score=score, malicious=malicious_activity, confidence=0.6 if score else 0.3,
            tags=tags,
            raw={
                "seen": True,
                "reputation": reputation,
                "suspicious": suspicious,
                "references": data.get("references"),
                "malicious_activity": malicious_activity,
                "credentials_leaked": credentials_leaked,
                "profiles": [str(p) for p in (details.get("profiles") or [])][:10],
            },
            ok=True, ts=now_utc(),
        )
