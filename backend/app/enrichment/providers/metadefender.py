"""OPSWAT MetaDefender enrichment provider (Round 11) — key-gated, file-hash AV.

MetaDefender Cloud's ``/v4/hash/{hash}`` returns multi-engine AV results for a
known hash: ``scan_results.total_detected_avs`` over ``total_avs`` — the same
detection-ratio shape as VirusTotal, mapped identically (ratio × 100). Key-gated
(``Secrets.metadefender_api_key``, the ``apikey`` header). A 404 means the hash has
never been scanned — a clean miss, not an error. Threat names are UNTRUSTED and
fenced before a prompt (#9).
"""

from __future__ import annotations

from ...constants import IndicatorKind
from ...models import ProviderResult
from ...utils import now_utc
from ..base import EnrichmentProvider, ProviderManifest, ProviderSecretField
from ._common import http_json, rate_guard

_URL = "https://api.metadefender.com/v4/hash/{hash}"


class MetaDefenderProvider(EnrichmentProvider):
    name = "metadefender"

    @classmethod
    def manifest(cls) -> ProviderManifest:
        return ProviderManifest(
            name=cls.name,
            display_name="MetaDefender (OPSWAT)",
            description=(
                "Multi-engine AV results for a file hash from OPSWAT MetaDefender "
                "Cloud — a VirusTotal-style detected/total engine ratio."
            ),
            indicator_kinds=[IndicatorKind.FILE_HASH],
            config_key="use_metadefender",
            secret_fields=[
                ProviderSecretField(
                    key="metadefender_api_key",
                    label="MetaDefender API key",
                    required=True,
                    help="Free API key from your OPSWAT MetaDefender Cloud account.",
                    help_link="https://metadefender.opswat.com/account",
                ),
            ],
            keyless=False,
            free_tier="Free tier key (daily request quota)",
            docs_url="https://docs.opswat.com/mdcloud",
            default_enabled=False,
            setup_steps=[
                "Create a free account at metadefender.opswat.com and copy the API "
                "key from your account page.",
                "Set TLSOC_METADEFENDER_API_KEY in .env (compose maps it to "
                "METADEFENDER_API_KEY), or paste it in this card (in-memory until "
                "restart).",
                "Flip this provider's toggle ON.",
            ],
            example=(
                "A second multi-engine opinion on a hash: when VirusTotal shows a "
                "borderline 3/70, MetaDefender's independent engine set confirming "
                "or contradicting it decides whether the case escalates."
            ),
        )

    async def _lookup(self, value: str, kind: IndicatorKind) -> ProviderResult:
        key = self._secret("metadefender_api_key")
        if not key:
            return ProviderResult(
                provider=self.name, indicator=value, indicator_kind=kind.value,
                ok=False, error="metadefender: no api key",
            )
        await rate_guard(self.name)
        data = await http_json(
            _URL.format(hash=value.strip()),
            headers={"apikey": key, "Accept": "application/json"},
        )
        scan = (data or {}).get("scan_results") if isinstance(data, dict) else None
        if not isinstance(scan, dict):
            # 404 / never scanned — a clean miss.
            return ProviderResult(
                provider=self.name, indicator=value, indicator_kind=kind.value,
                score=0, malicious=False, tags=[], raw={"seen": False},
                ok=True, ts=now_utc(),
            )
        try:
            detected = int(scan.get("total_detected_avs") or 0)
            total = int(scan.get("total_avs") or 0)
        except (TypeError, ValueError):
            detected, total = 0, 0
        score = int(round(detected / total * 100)) if total else 0
        overall = str(scan.get("scan_all_result_a") or "")
        threat_names: list[str] = []
        details = scan.get("scan_details")
        if isinstance(details, dict):
            for engine in details.values():
                if isinstance(engine, dict) and engine.get("threat_found"):
                    threat_names.append(str(engine["threat_found"]))
        tags: list[str] = [f"detections:{detected}/{total}"]
        if overall:
            tags.append(f"result:{overall}")
        tags.extend(sorted(set(threat_names))[:5])
        return ProviderResult(
            provider=self.name, indicator=value, indicator_kind=kind.value,
            # Detection ratio maps directly (VirusTotal-shape graded feed).
            score=score, malicious=score >= 50, confidence=0.75 if total else 0.2,
            tags=tags,
            raw={
                "seen": True,
                "detected": detected,
                "total_engines": total,
                "overall": overall,
                "threats": sorted(set(threat_names))[:15],
            },
            ok=True, ts=now_utc(),
        )
