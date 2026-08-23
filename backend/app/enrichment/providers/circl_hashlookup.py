"""CIRCL hashlookup enrichment provider (Round 11) — KEYLESS, default-on.

CIRCL's ``hashlookup.circl.lu`` answers "is this hash a KNOWN-GOOD file?" from
curated datasets (NSRL and friends). It is the mirror image of MalwareBazaar: a HIT
means the hash is a well-known, catalogued binary (usually benign OS/vendor
software), which is strong triage context for de-prioritising 'unknown binary'
alerts. It is CONTEXT, never a verdict — score stays 0 and ``malicious`` stays
False in every branch, so it can never alone cross the legacy ``max()`` >= 50 cut
(#3). A 404 means "hash not in any known-good dataset" — that is a neutral miss,
NOT a bad sign on its own. Keyless ⇒ ``http_json_soft`` (advisory; transport errors
degrade to no-data, never poison the legacy error contract). Every dataset/product
string is UNTRUSTED and fenced before a prompt (#9).
"""

from __future__ import annotations

from ...constants import IndicatorKind
from ...models import ProviderResult
from ...utils import now_utc
from ..base import EnrichmentProvider, ProviderManifest
from ._common import http_json_soft, rate_guard

_BASE = "https://hashlookup.circl.lu/lookup"

# hex length → the hashlookup path segment
_ALGO_BY_LEN = {32: "md5", 40: "sha1", 64: "sha256"}


class CirclHashlookupProvider(EnrichmentProvider):
    name = "circl_hashlookup"

    @classmethod
    def manifest(cls) -> ProviderManifest:
        return ProviderManifest(
            name=cls.name,
            display_name="CIRCL hashlookup",
            description=(
                "Known-GOOD file-hash lookup (NSRL and other curated datasets) from "
                "CIRCL. A hit means a well-known catalogued binary — benign context, "
                "never a verdict."
            ),
            indicator_kinds=[IndicatorKind.FILE_HASH],
            config_key="use_circl_hashlookup",
            secret_fields=[],
            keyless=True,
            free_tier="Keyless, no signup (public CIRCL service; be polite)",
            docs_url="https://www.circl.lu/services/hashlookup/",
            default_enabled=True,
            setup_steps=[
                "Nothing to set up — CIRCL hashlookup is keyless and this provider "
                "ships enabled.",
                "Requires outbound HTTPS to hashlookup.circl.lu.",
            ],
            example=(
                "The inverse of a malware feed: when an EDR flags an 'unknown "
                "binary' whose SHA-256 hashlookup knows as a stock Windows system "
                "file, the analyst can stand down instead of sandboxing it."
            ),
        )

    async def _lookup(self, value: str, kind: IndicatorKind) -> ProviderResult:
        h = value.strip().lower()
        algo = _ALGO_BY_LEN.get(len(h))
        if algo is None:
            # Unsupported hash length — neutral, not an error (context provider).
            return ProviderResult(
                provider=self.name, indicator=value, indicator_kind=kind.value,
                score=0, malicious=False, tags=[], raw={"supported": False},
                ok=True, ts=now_utc(),
            )
        await rate_guard(self.name)
        data = await http_json_soft(f"{_BASE}/{algo}/{h}", timeout=4.0)
        if not isinstance(data, dict) or not (data.get("MD5") or data.get("SHA-1") or data.get("SHA-256")):
            # 404 / no record — the hash is simply not in a known-good dataset.
            return ProviderResult(
                provider=self.name, indicator=value, indicator_kind=kind.value,
                score=0, malicious=False, tags=[], raw={"known": False},
                ok=True, ts=now_utc(),
            )
        filename = data.get("FileName")
        product = data.get("ProductCode") or data.get("source")
        trust = data.get("hashlookup:trust")
        tags: list[str] = ["known_good"]
        if trust is not None:
            tags.append(f"trust:{trust}")
        return ProviderResult(
            provider=self.name, indicator=value, indicator_kind=kind.value,
            # Known-good context: ALWAYS 0 / non-malicious (#3-safe).
            score=0, malicious=False, confidence=0.5,
            tags=tags,
            raw={
                "known": True,
                "file_name": str(filename)[:200] if filename else None,
                "product": str(product)[:200] if product else None,
                "trust": trust,
            },
            ok=True, ts=now_utc(),
        )
