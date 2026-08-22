"""Onionoo (Tor Project) enrichment provider (Round 11) — KEYLESS, default-on.

The Tor Project's Onionoo API (``/details?search={ip}``) reports whether an IP is a
known Tor relay and whether it is an EXIT node. Same posture as Spur: ANONYMITY
context, not a malice verdict — an exit node scores 40, a non-exit relay 20,
``malicious=False`` in every branch so it never alone crosses the legacy ``max()``
>= 50 cut (#3). Keyless ⇒ ``http_json_soft`` (advisory). Nickname strings are
UNTRUSTED and fenced before a prompt (#9).
"""

from __future__ import annotations

from ...constants import IndicatorKind
from ...models import ProviderResult
from ...utils import now_utc
from ..base import EnrichmentProvider, ProviderManifest
from ._common import http_json_soft, rate_guard

_URL = "https://onionoo.torproject.org/details"


class OnionooProvider(EnrichmentProvider):
    name = "onionoo"

    @classmethod
    def manifest(cls) -> ProviderManifest:
        return ProviderManifest(
            name=cls.name,
            display_name="Onionoo (Tor Project)",
            description=(
                "Authoritative Tor-network lookup: is this IP a Tor relay, and is it "
                "an exit node? Anonymity context, not a malice verdict."
            ),
            indicator_kinds=[IndicatorKind.IP],
            config_key="use_onionoo",
            secret_fields=[],
            keyless=True,
            free_tier="Keyless, no signup (official Tor Project API)",
            docs_url="https://metrics.torproject.org/onionoo.html",
            default_enabled=True,
            setup_steps=[
                "Nothing to set up — Onionoo is keyless and this provider ships "
                "enabled.",
                "Requires outbound HTTPS to onionoo.torproject.org.",
            ],
            example=(
                "Straight from the Tor consensus: a password-spray source that is a "
                "live Tor exit node explains the rotating identities and tells the "
                "analyst that blocking the single IP is pointless — block the "
                "behaviour instead."
            ),
        )

    async def _lookup(self, value: str, kind: IndicatorKind) -> ProviderResult:
        await rate_guard(self.name)
        data = await http_json_soft(_URL, params={"search": value}, timeout=4.0)
        relays = data.get("relays") if isinstance(data, dict) else None
        relays = relays if isinstance(relays, list) else []
        matched = [r for r in relays if isinstance(r, dict)]
        if not matched:
            return ProviderResult(
                provider=self.name, indicator=value, indicator_kind=kind.value,
                score=0, malicious=False, tags=[], raw={"tor_relay": False},
                ok=True, ts=now_utc(),
            )
        first = matched[0]
        flags = [str(f) for f in (first.get("flags") or [])]
        running = bool(first.get("running"))
        is_exit = "Exit" in flags or bool(first.get("exit_addresses"))
        # Anonymity context (#3): exit 40, non-exit relay 20 — never >= 50.
        score = 40 if is_exit else 20
        tags = ["tor_exit" if is_exit else "tor_relay"]
        if running:
            tags.append("running")
        return ProviderResult(
            provider=self.name, indicator=value, indicator_kind=kind.value,
            score=score, malicious=False, confidence=0.6,
            tags=tags,
            raw={
                "tor_relay": True,
                "exit": is_exit,
                "running": running,
                "nickname": str(first.get("nickname"))[:64] if first.get("nickname") else None,
                "flags": flags[:10],
                "country": first.get("country"),
            },
            ok=True, ts=now_utc(),
        )
